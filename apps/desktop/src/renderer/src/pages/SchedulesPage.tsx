import { useEffect, useState } from 'react'
import type { CronFrequency, CronJob, ModelInfo } from '@omega/sdk'
import { engineClient } from '../lib/engine'

const FREQ_PRESETS: Array<{ label: string; freq: CronFrequency }> = [
  { label: 'Every 5 min', freq: { kind: 'minutes', every: 5 } },
  { label: 'Every 30 min', freq: { kind: 'minutes', every: 30 } },
  { label: 'Hourly', freq: { kind: 'hourly', minute: 0 } },
  { label: 'Daily 09:00', freq: { kind: 'daily', hour: 9, minute: 0 } },
  { label: 'Weekly Mon 09:00', freq: { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 } }
]

function freqLabel(f: CronFrequency): string {
  switch (f.kind) {
    case 'minutes': return `Every ${f.every} min`
    case 'hourly': return `Hourly @ :${String(f.minute).padStart(2, '0')}`
    case 'daily': return `Daily ${pad(f.hour)}:${pad(f.minute)}`
    case 'weekly': return `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][f.dayOfWeek]} ${pad(f.hour)}:${pad(f.minute)}`
    case 'custom': return `cron: ${f.cron}`
  }
}
const pad = (n: number) => String(n).padStart(2, '0')

export function SchedulesPage({ models }: { models: ModelInfo[] }) {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [editing, setEditing] = useState<Partial<CronJob> | null>(null)

  const reload = async () => setJobs(await engineClient.cron.list())
  useEffect(() => {
    reload()
    const off = engineClient.cron.onChange(setJobs)
    return () => off()
  }, [])

  return (
    <div className="flex h-full">
      <div className="w-1/2 overflow-y-auto border-r border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Scheduled jobs</h2>
          <button
            type="button"
            onClick={() =>
              setEditing({
                name: 'New job',
                prompt: '',
                modelId: models[0]?.id ?? '',
                frequency: { kind: 'daily', hour: 9, minute: 0 },
                delivery: [{ kind: 'memory' }],
                enabled: true,
                agentMode: true,
                skills: []
              })
            }
            className="rounded bg-indigo-600 px-3 py-1 text-xs"
          >
            New
          </button>
        </div>
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li
              key={j.id}
              onClick={() => setEditing(j)}
              className={`cursor-pointer rounded-lg border p-3 ${editing?.id === j.id ? 'border-indigo-600 bg-indigo-950/30' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium">{j.name}</p>
                <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] ${j.enabled ? 'bg-emerald-700/30 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}>
                  {j.enabled ? 'on' : 'off'}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{freqLabel(j.frequency)}</p>
              {j.lastStatus && (
                <p className={`mt-1 text-[10px] ${j.lastStatus === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
                  Last: {j.lastStatus}
                  {j.lastError ? ` — ${j.lastError.slice(0, 80)}` : ''}
                </p>
              )}
              <p className="mt-1 text-[10px] text-zinc-600">
                Next: {j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '-'}
              </p>
              <div className="mt-2 flex gap-2 text-[10px]">
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await engineClient.cron.runNow(j.id)
                  }}
                  className="rounded bg-zinc-800 px-2 py-0.5"
                >
                  Run now
                </button>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await engineClient.cron.pause(j.id, j.enabled)
                  }}
                  className="rounded bg-zinc-800 px-2 py-0.5"
                >
                  {j.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (confirm(`Delete "${j.name}"?`)) {
                      await engineClient.cron.delete(j.id)
                      if (editing?.id === j.id) setEditing(null)
                    }
                  }}
                  className="rounded bg-zinc-800 px-2 py-0.5 text-red-300"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
          {jobs.length === 0 && <p className="text-sm text-zinc-500">No scheduled jobs.</p>}
        </ul>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!editing ? (
          <p className="text-sm text-zinc-500">Select or create a job.</p>
        ) : (
          <JobEditor
            value={editing}
            models={models}
            onCancel={() => setEditing(null)}
            onSave={async (v) => {
              const saved = await engineClient.cron.save(v)
              setEditing(saved)
              reload()
            }}
          />
        )}
      </div>
    </div>
  )
}

function JobEditor({
  value,
  models,
  onSave,
  onCancel
}: {
  value: Partial<CronJob>
  models: ModelInfo[]
  onSave: (v: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt'> & { id?: string }) => void
  onCancel: () => void
}) {
  const [j, setJ] = useState<Partial<CronJob>>(value)
  useEffect(() => setJ(value), [value])

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <input
        value={j.name ?? ''}
        onChange={(e) => setJ({ ...j, name: e.target.value })}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-lg font-semibold"
        placeholder="Job name"
      />
      <textarea
        value={j.prompt ?? ''}
        onChange={(e) => setJ({ ...j, prompt: e.target.value })}
        rows={6}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        placeholder="Prompt the agent will run on each tick"
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-300">Model</p>
          <select
            value={j.modelId ?? ''}
            onChange={(e) => setJ({ ...j, modelId: e.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-300">Frequency</p>
          <select
            value={`${j.frequency?.kind ?? 'daily'}`}
            onChange={(e) => {
              const kind = e.target.value as CronFrequency['kind']
              const next: CronFrequency =
                kind === 'minutes' ? { kind: 'minutes', every: 30 } :
                kind === 'hourly' ? { kind: 'hourly', minute: 0 } :
                kind === 'daily' ? { kind: 'daily', hour: 9, minute: 0 } :
                kind === 'weekly' ? { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 } :
                { kind: 'custom', cron: '*/15 * * * *' }
              setJ({ ...j, frequency: next })
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
          >
            <option value="minutes">Every N minutes</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom cron</option>
          </select>
        </div>
      </div>
      <FrequencyDetails value={j.frequency!} onChange={(f) => setJ({ ...j, frequency: f })} />

      <div>
        <p className="mb-1 text-xs font-medium text-zinc-300">Presets</p>
        <div className="flex flex-wrap gap-2">
          {FREQ_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setJ({ ...j, frequency: p.freq })}
              className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-zinc-300">Delivery</p>
        <div className="space-y-1 text-xs text-zinc-400">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!j.delivery?.find((d) => d.kind === 'memory')}
              onChange={(e) =>
                setJ({
                  ...j,
                  delivery: e.target.checked
                    ? [...(j.delivery ?? []).filter((d) => d.kind !== 'memory'), { kind: 'memory' }]
                    : (j.delivery ?? []).filter((d) => d.kind !== 'memory')
                })
              }
            />
            Append to memory
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!j.delivery?.find((d) => d.kind === 'notification')}
              onChange={(e) =>
                setJ({
                  ...j,
                  delivery: e.target.checked
                    ? [...(j.delivery ?? []).filter((d) => d.kind !== 'notification'), { kind: 'notification' }]
                    : (j.delivery ?? []).filter((d) => d.kind !== 'notification')
                })
              }
            />
            Desktop notification
          </label>
          <WebhookDelivery
            value={j.delivery?.find((d) => d.kind === 'webhook')?.kind === 'webhook'
              ? (j.delivery.find((d) => d.kind === 'webhook') as { kind: 'webhook'; url: string }).url
              : ''}
            onChange={(url) =>
              setJ({
                ...j,
                delivery: url
                  ? [...(j.delivery ?? []).filter((d) => d.kind !== 'webhook'), { kind: 'webhook', url }]
                  : (j.delivery ?? []).filter((d) => d.kind !== 'webhook')
              })
            }
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={j.agentMode !== false}
          onChange={(e) => setJ({ ...j, agentMode: e.target.checked })}
        />
        Use full agent (tools + memory)
      </label>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={j.enabled !== false}
          onChange={(e) => setJ({ ...j, enabled: e.target.checked })}
        />
        Enabled
      </label>

      <div className="flex justify-between border-t border-zinc-800 pt-4">
        <button type="button" onClick={onCancel} className="text-xs text-zinc-400">
          Cancel
        </button>
        <button
          type="button"
          disabled={!j.name || !j.prompt || !j.modelId || !j.frequency}
          onClick={() =>
            onSave({
              id: j.id,
              name: j.name!,
              prompt: j.prompt!,
              modelId: j.modelId!,
              frequency: j.frequency!,
              delivery: j.delivery ?? [{ kind: 'memory' }],
              enabled: j.enabled !== false,
              agentMode: j.agentMode !== false,
              skills: j.skills ?? [],
              lastRunAt: j.lastRunAt,
              lastStatus: j.lastStatus,
              lastError: j.lastError
            })
          }
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  )
}

function FrequencyDetails({ value, onChange }: { value: CronFrequency; onChange: (v: CronFrequency) => void }) {
  if (value.kind === 'minutes') {
    return (
      <NumberField label="Every (minutes)" value={value.every} min={1} max={1440} onChange={(every) => onChange({ kind: 'minutes', every })} />
    )
  }
  if (value.kind === 'hourly') {
    return (
      <NumberField label="Minute" value={value.minute} min={0} max={59} onChange={(minute) => onChange({ kind: 'hourly', minute })} />
    )
  }
  if (value.kind === 'daily') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Hour" value={value.hour} min={0} max={23} onChange={(hour) => onChange({ ...value, hour })} />
        <NumberField label="Minute" value={value.minute} min={0} max={59} onChange={(minute) => onChange({ ...value, minute })} />
      </div>
    )
  }
  if (value.kind === 'weekly') {
    return (
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-300">Day</p>
          <select
            value={value.dayOfWeek}
            onChange={(e) => onChange({ ...value, dayOfWeek: Number(e.target.value) })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
          >
            {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => (
              <option key={d} value={i}>{d}</option>
            ))}
          </select>
        </div>
        <NumberField label="Hour" value={value.hour} min={0} max={23} onChange={(hour) => onChange({ ...value, hour })} />
        <NumberField label="Minute" value={value.minute} min={0} max={59} onChange={(minute) => onChange({ ...value, minute })} />
      </div>
    )
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-300">Cron expression</p>
      <input
        value={value.cron}
        onChange={(e) => onChange({ kind: 'custom', cron: e.target.value })}
        placeholder="*/15 * * * *"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm font-mono"
      />
      <p className="mt-1 text-[10px] text-zinc-500">Minimal support: only `*/N * * * *` (minute interval) is honored.</p>
    </div>
  )
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-300">{label}</p>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
      />
    </div>
  )
}

function WebhookDelivery({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [enabled, setEnabled] = useState(!!value)
  return (
    <div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked)
            if (!e.target.checked) onChange('')
          }}
        />
        Webhook URL
      </label>
      {enabled && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://hooks.example.com/..."
          className="ml-6 mt-1 w-[calc(100%-1.5rem)] rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
        />
      )}
    </div>
  )
}
