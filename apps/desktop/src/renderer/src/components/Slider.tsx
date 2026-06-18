import { useId } from 'react'

export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  presets
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  presets?: Array<{ label: string; value: number }>
}) {
  const id = useId()
  const safeMax = Math.max(min + step, max)
  const fmt = format ?? ((v: number) => String(v))
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-zinc-300">
          {label}
        </label>
        <input
          type="number"
          value={value}
          min={min}
          max={safeMax}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-right text-xs"
        />
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={safeMax}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="omega-slider w-full"
      />
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span>{fmt(min)}</span>
        {presets && (
          <div className="flex gap-1">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onChange(p.value)}
                className={`rounded px-1.5 py-0.5 ${value === p.value ? 'bg-indigo-700 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <span>{fmt(safeMax)}</span>
      </div>
      {hint && <p className="text-[10px] text-zinc-600">{hint}</p>}
    </div>
  )
}

export function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-200">{label}</p>
        {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-indigo-600' : 'bg-zinc-700'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
    </label>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  hint?: string
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-300">{label}</p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  )
}
