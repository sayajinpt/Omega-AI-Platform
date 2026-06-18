import { useEffect, useState } from 'react'
import type { Soul } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function SoulPage() {
  const [soul, setSoul] = useState<Soul | null>(null)
  const [dirty, setDirty] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    engineClient.soul.get().then(setSoul)
  }, [])

  if (!soul) return <p className="p-6 text-sm text-zinc-500">Loading soul…</p>

  const set = (patch: Partial<Soul>) => {
    setSoul({ ...soul, ...patch })
    setDirty(true)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">Soul</h2>
        <p className="text-xs text-zinc-500">
          Identity, values, style, and goals. Injected at the top of every agent prompt.
        </p>
      </div>

      <Field
        label="Identity"
        hint="Who Omega is."
        value={soul.identity}
        onChange={(v) => set({ identity: v })}
      />
      <Field
        label="Values"
        hint="What Omega cares about."
        value={soul.values}
        onChange={(v) => set({ values: v })}
      />
      <Field
        label="Style"
        hint="How Omega writes and behaves."
        value={soul.style}
        onChange={(v) => set({ style: v })}
      />
      <Field
        label="Goals"
        hint="What Omega is always trying to do."
        value={soul.goals}
        onChange={(v) => set({ goals: v })}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty}
          onClick={async () => {
            const saved = await engineClient.soul.set(soul)
            setSoul(saved)
            setDirty(false)
            setSavedMsg('Saved.')
            setTimeout(() => setSavedMsg(''), 1500)
          }}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={async () => {
            const def = await engineClient.soul.reset()
            setSoul(def)
            setDirty(false)
          }}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400"
        >
          Reset to default
        </button>
        {savedMsg && <span className="text-xs text-emerald-400">{savedMsg}</span>}
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-xs font-medium text-zinc-300">{label}</p>
        {hint && <p className="text-[10px] text-zinc-500">{hint}</p>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
      />
    </div>
  )
}
