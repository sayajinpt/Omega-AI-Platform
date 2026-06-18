import { useEffect, useRef, useState } from 'react'
import type { CompanionCustomColorKey, CompanionCustomColors } from '../lib/companion-color-scheme'
import {
  COMPANION_COLOR_FIELD_GROUPS,
  getCompanionCustomColors,
  normalizeHexColor,
  onCompanionCustomColors,
  resetCompanionCustomColors,
  setCompanionCustomColor
} from '../lib/companion-color-scheme'

function ColorFieldRow({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: string
  onChange: (hex: string) => void
}) {
  const picker = value.startsWith('#') && value.length >= 7 ? value.slice(0, 7) : '#818cf8'
  return (
    <label className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 py-0.5 text-xs">
      <span className="text-zinc-300">
        {label}
        {hint ? <span className="ml-1 text-[10px] text-zinc-500">({hint})</span> : null}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="color"
          value={picker}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-zinc-600 bg-transparent"
          aria-label={`${label} color`}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-[4.5rem] rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 font-mono text-[10px] text-zinc-300"
          spellCheck={false}
        />
      </span>
    </label>
  )
}

export function CompanionColorSettingsMenu({
  onColorsChange
}: {
  onColorsChange?: (colors: CompanionCustomColors) => void
}) {
  const [open, setOpen] = useState(false)
  const [colors, setColors] = useState<CompanionCustomColors>(() => getCompanionCustomColors())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return onCompanionCustomColors(setColors)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const update = (key: CompanionCustomColorKey, hex: string) => {
    const normalized = normalizeHexColor(hex, colors[key])
    const next = { ...colors, [key]: normalized }
    setCompanionCustomColor(key, normalized)
    onColorsChange?.(next)
  }

  const reset = () => {
    resetCompanionCustomColors()
    onColorsChange?.(getCompanionCustomColors())
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="Companion animation colors"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-600 px-2 py-0.5 font-medium text-zinc-300 hover:border-indigo-500/50 hover:bg-zinc-800 hover:text-indigo-200"
      >
        <svg
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-indigo-300/90"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5c0 1.2-.5 2.4-1.4 3.2L12 22l-8.1-6.8A4.8 4.8 0 0 1 2.5 12 9.5 9.5 0 0 1 12 2.5z" />
          <circle cx="8.5" cy="10.5" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="12" cy="8" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="15.5" cy="11" r="1.25" fill="currentColor" stroke="none" />
        </svg>
        Colors
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Companion animation colors"
          className="absolute left-0 top-full z-[90] mt-1 max-h-[min(70vh,28rem)] w-[17rem] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
        >
          <p className="mb-2 px-0.5 text-[10px] leading-snug text-zinc-500">
            Set colors for idle vs active connections and related viz. Matrix and spider views use
            derived shades from these picks.
          </p>
          {COMPANION_COLOR_FIELD_GROUPS.map((group) => (
            <section key={group.title} className="mb-2 border-b border-zinc-800 pb-2 last:mb-0 last:border-0">
              <h3 className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {group.title}
              </h3>
              {group.fields.map((f) => (
                <ColorFieldRow
                  key={f.key}
                  label={f.label}
                  hint={f.hint}
                  value={colors[f.key]}
                  onChange={(hex) => update(f.key, hex)}
                />
              ))}
            </section>
          ))}
          <div className="mt-1 flex justify-end gap-1 border-t border-zinc-800 pt-2">
            <button
              type="button"
              onClick={reset}
              className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              Reset defaults
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded bg-indigo-600/30 px-2 py-0.5 text-[10px] font-medium text-indigo-100 hover:bg-indigo-600/45"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
