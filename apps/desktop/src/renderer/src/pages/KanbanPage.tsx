import { useEffect, useMemo, useState } from 'react'
import type { KanbanStatus, KanbanTask, ModelInfo, Skill } from '@omega/sdk'
import { engineClient } from '../lib/engine'

const COLUMNS: { id: KanbanStatus; label: string; tint: string }[] = [
  { id: 'backlog', label: 'Backlog', tint: 'bg-zinc-800' },
  { id: 'ready', label: 'Ready', tint: 'bg-indigo-900/40' },
  { id: 'doing', label: 'Doing', tint: 'bg-amber-900/40' },
  { id: 'done', label: 'Done', tint: 'bg-emerald-900/30' },
  { id: 'blocked', label: 'Blocked', tint: 'bg-red-900/30' }
]

export function KanbanPage({ models }: { models: ModelInfo[] }) {
  const [tasks, setTasks] = useState<KanbanTask[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [editing, setEditing] = useState<Partial<KanbanTask> | null>(null)
  const [dispatching, setDispatching] = useState(false)

  const reload = async () => setTasks(await engineClient.kanban.list())
  useEffect(() => {
    reload()
    engineClient.skills.list().then(setSkills)
    const off = engineClient.kanban.onChange(setTasks)
    return () => off()
  }, [])

  const grouped = useMemo(() => {
    const g: Record<KanbanStatus, KanbanTask[]> = { backlog: [], ready: [], doing: [], done: [], blocked: [] }
    for (const t of tasks) g[t.status].push(t)
    return g
  }, [tasks])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div>
          <h2 className="text-lg font-semibold">Kanban</h2>
          <p className="text-xs text-zinc-500">Agent picks up Ready tasks. Move tasks by clicking the column buttons.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              setEditing({
                title: '',
                body: '',
                status: 'backlog',
                priority: 'normal',
                assignee: 'agent',
                skills: []
              })
            }
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs"
          >
            New task
          </button>
          <button
            type="button"
            disabled={dispatching || grouped.ready.length === 0}
            onClick={async () => {
              setDispatching(true)
              try {
                await engineClient.kanban.dispatch()
              } finally {
                setDispatching(false)
              }
            }}
            className="rounded bg-emerald-700 px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {dispatching ? 'Dispatching…' : 'Dispatch next'}
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-5 gap-3 overflow-y-auto p-4">
        {COLUMNS.map((col) => (
          <div key={col.id} className="flex min-h-0 flex-col">
            <div className={`mb-2 rounded-t px-3 py-1.5 text-xs font-medium ${col.tint}`}>
              {col.label} <span className="ml-1 opacity-60">({grouped[col.id].length})</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto">
              {grouped[col.id].map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  onClick={() => setEditing(t)}
                  onMove={(s) => engineClient.kanban.move(t.id, s)}
                  onDispatch={async () => {
                    setDispatching(true)
                    try {
                      await engineClient.kanban.dispatch(t.id)
                    } finally {
                      setDispatching(false)
                    }
                  }}
                  onPin={async () => {
                    await engineClient.office.kanbanPin(t.id, !t.officePinned)
                    await reload()
                  }}
                  onMonitor={async () => {
                    await engineClient.office.kanbanMonitor(t.id)
                  }}
                  onDelete={async () => {
                    if (confirm(`Delete "${t.title}"?`)) await engineClient.kanban.delete(t.id)
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <TaskEditor
          value={editing}
          models={models}
          skills={skills}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            const saved = await engineClient.kanban.save(v)
            setEditing(saved)
          }}
        />
      )}
    </div>
  )
}

function Card({
  task,
  onClick,
  onMove,
  onDispatch,
  onPin,
  onMonitor,
  onDelete
}: {
  task: KanbanTask
  onClick: () => void
  onMove: (s: KanbanStatus) => void
  onDispatch: () => void
  onPin: () => void
  onMonitor: () => void
  onDelete: () => void
}) {
  const priColor =
    task.priority === 'urgent'
      ? 'bg-red-600/80'
      : task.priority === 'high'
        ? 'bg-amber-500/70'
        : task.priority === 'low'
          ? 'bg-zinc-600/70'
          : 'bg-indigo-600/70'
  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-3 hover:border-zinc-700"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-medium">{task.title}</p>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] text-white ${priColor}`}>{task.priority}</span>
      </div>
      {task.body && <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">{task.body}</p>}
      {task.skills.length > 0 && (
        <p className="mt-1 text-[10px] text-zinc-600">skills: {task.skills.join(', ')}</p>
      )}
      {task.error && <p className="mt-1 text-[10px] text-red-400">err: {task.error.slice(0, 60)}</p>}
      <div className="mt-2 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
        {(['backlog','ready','doing','done','blocked'] as KanbanStatus[])
          .filter((s) => s !== task.status)
          .map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onMove(s)}
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:bg-zinc-700"
            >
              → {s}
            </button>
          ))}
        {task.status === 'ready' && (
          <button
            type="button"
            onClick={onDispatch}
            className="rounded bg-emerald-700/80 px-1.5 py-0.5 text-[9px] text-white"
          >
            run
          </button>
        )}
        <button type="button" onClick={onPin} className="rounded bg-indigo-900/50 px-1.5 py-0.5 text-[9px]">
          {task.officePinned ? 'unpin' : 'office'}
        </button>
        <button type="button" onClick={onMonitor} className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[9px]">
          monitor
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-red-300"
        >
          ×
        </button>
      </div>
    </div>
  )
}

function TaskEditor({
  value,
  models,
  skills,
  onClose,
  onSave
}: {
  value: Partial<KanbanTask>
  models: ModelInfo[]
  skills: Skill[]
  onClose: () => void
  onSave: (v: Partial<KanbanTask> & { title: string }) => void
}) {
  const [t, setT] = useState<Partial<KanbanTask>>(value)
  useEffect(() => setT(value), [value])

  return (
    <div onClick={onClose} className="fixed inset-0 z-30 flex justify-end bg-black/60 backdrop-blur-sm">
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-6"
      >
        <input
          value={t.title ?? ''}
          onChange={(e) => setT({ ...t, title: e.target.value })}
          placeholder="Task title"
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-lg font-semibold"
        />
        <textarea
          value={t.body ?? ''}
          onChange={(e) => setT({ ...t, body: e.target.value })}
          rows={6}
          placeholder="What needs to happen…"
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <p className="mb-1 text-zinc-400">Status</p>
            <select
              value={t.status ?? 'backlog'}
              onChange={(e) => setT({ ...t, status: e.target.value as KanbanStatus })}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
            >
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="mb-1 text-zinc-400">Priority</p>
            <select
              value={t.priority ?? 'normal'}
              onChange={(e) => setT({ ...t, priority: e.target.value as KanbanTask['priority'] })}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
            >
              <option value="low">low</option>
              <option value="normal">normal</option>
              <option value="high">high</option>
              <option value="urgent">urgent</option>
            </select>
          </div>
          <div>
            <p className="mb-1 text-zinc-400">Assignee</p>
            <select
              value={t.assignee ?? 'agent'}
              onChange={(e) => setT({ ...t, assignee: e.target.value as KanbanTask['assignee'] })}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
            >
              <option value="agent">agent</option>
              <option value="user">user</option>
            </select>
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-400">Model (optional)</p>
          <select
            value={t.modelId ?? ''}
            onChange={(e) => setT({ ...t, modelId: e.target.value || undefined })}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          >
            <option value="">(use default)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-400">Skills</p>
          <div className="flex flex-wrap gap-1">
            {skills.map((s) => {
              const active = (t.skills ?? []).includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() =>
                    setT({
                      ...t,
                      skills: active
                        ? (t.skills ?? []).filter((x) => x !== s.id)
                        : [...(t.skills ?? []), s.id]
                    })
                  }
                  className={`rounded px-2 py-0.5 text-[10px] ${active ? 'bg-indigo-700 text-white' : 'bg-zinc-800 text-zinc-400'}`}
                >
                  {s.name}
                </button>
              )
            })}
            {skills.length === 0 && <p className="text-[10px] text-zinc-500">No skills defined.</p>}
          </div>
        </div>
        {t.result && (
          <div>
            <p className="mb-1 text-xs text-zinc-400">Last result</p>
            <pre className="max-h-64 overflow-y-auto rounded bg-zinc-900 p-3 text-[11px] text-emerald-200">{t.result}</pre>
          </div>
        )}
        <div className="flex justify-between border-t border-zinc-800 pt-3">
          <button type="button" onClick={onClose} className="text-xs text-zinc-400">Close</button>
          <button
            type="button"
            disabled={!t.title}
            onClick={() => onSave(t as Partial<KanbanTask> & { title: string })}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </aside>
    </div>
  )
}
