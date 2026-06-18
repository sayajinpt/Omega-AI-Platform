import { useEffect, useState } from 'react'
import type { Skill, SkillContent } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [editing, setEditing] = useState<SkillContent | null>(null)
  const [filter, setFilter] = useState('')

  const reload = async () => setSkills(await engineClient.skills.list())
  useEffect(() => {
    reload()
  }, [])

  const filtered = skills.filter(
    (s) =>
      !filter ||
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      s.description.toLowerCase().includes(filter.toLowerCase()) ||
      (s.tags ?? []).some((t) => t.toLowerCase().includes(filter.toLowerCase()))
  )

  return (
    <div className="flex h-full">
      <div className="w-1/3 border-r border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Skills</h2>
          <button
            type="button"
            onClick={() =>
              setEditing({
                id: '',
                name: 'New skill',
                description: '',
                enabled: true,
                path: '',
                body: '# What this skill does\n\nGuidance for the agent…'
              })
            }
            className="rounded bg-indigo-600 px-3 py-1 text-xs"
          >
            New
          </button>
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="mb-3 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
        />
        <ul className="space-y-2">
          {filtered.map((s) => (
            <li
              key={s.id}
              className={`group cursor-pointer rounded-lg border p-3 ${
                editing?.id === s.id
                  ? 'border-indigo-600 bg-indigo-950/30'
                  : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
              }`}
              onClick={async () => {
                const full = await engineClient.skills.get(s.id)
                if (full) setEditing(full)
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-sm font-medium">{s.name}</p>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await engineClient.skills.toggle(s.id, !s.enabled)
                    reload()
                  }}
                  className={`shrink-0 rounded px-2 py-0.5 text-[10px] ${s.enabled ? 'bg-emerald-700/30 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}
                >
                  {s.enabled ? 'enabled' : 'disabled'}
                </button>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{s.description}</p>
              {s.tags && s.tags.length > 0 && (
                <p className="mt-1 text-[10px] text-zinc-600">{s.tags.join(' · ')}</p>
              )}
            </li>
          ))}
          {filtered.length === 0 && <p className="text-sm text-zinc-500">No skills.</p>}
        </ul>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!editing ? (
          <div className="text-sm text-zinc-500">
            Select a skill or create a new one. Active skills are injected into the agent system
            prompt automatically.
          </div>
        ) : (
          <SkillEditor
            value={editing}
            onSave={async (v) => {
              const saved = await engineClient.skills.save(v)
              setEditing(saved)
              reload()
            }}
            onDelete={async () => {
              if (!editing.id) return
              if (!confirm(`Delete skill "${editing.name}"?`)) return
              await engineClient.skills.delete(editing.id)
              setEditing(null)
              reload()
            }}
          />
        )}
      </div>
    </div>
  )
}

function SkillEditor({
  value,
  onSave,
  onDelete
}: {
  value: SkillContent
  onSave: (v: {
    id?: string
    name: string
    description: string
    category?: string
    tags?: string[]
    enabled?: boolean
    body: string
  }) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(value.name)
  const [description, setDescription] = useState(value.description)
  const [category, setCategory] = useState(value.category ?? '')
  const [tags, setTags] = useState((value.tags ?? []).join(', '))
  const [enabled, setEnabled] = useState(value.enabled)
  const [body, setBody] = useState(value.body)

  useEffect(() => {
    setName(value.name)
    setDescription(value.description)
    setCategory(value.category ?? '')
    setTags((value.tags ?? []).join(', '))
    setEnabled(value.enabled)
    setBody(value.body)
  }, [value])

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-lg font-semibold"
        />
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="One-line description"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
      />
      <div className="grid grid-cols-2 gap-3">
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (e.g. research)"
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tags, comma, separated"
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={20}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs"
      />
      <div className="flex items-center justify-between">
        {value.id && (
          <button type="button" onClick={onDelete} className="text-xs text-red-400">
            Delete
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            onSave({
              id: value.id || undefined,
              name,
              description,
              category: category || undefined,
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
              enabled,
              body
            })
          }
          className="ml-auto rounded-lg bg-indigo-600 px-5 py-2 text-sm"
        >
          Save
        </button>
      </div>
    </div>
  )
}
