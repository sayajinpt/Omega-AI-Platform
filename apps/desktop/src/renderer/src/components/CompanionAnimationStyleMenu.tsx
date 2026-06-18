import { useEffect, useRef, useState } from 'react'
import {
  COMPANION_ANIMATION_STYLES,
  getCompanionAnimationStyle,
  onCompanionAnimationStyle,
  setCompanionAnimationStyle,
  type CompanionAnimationStyle
} from '../lib/companion-animation-style'
import { engineClient } from '../lib/engine'

export function CompanionAnimationStyleMenu({
  avatarMonitorOn,
  onStyleChange
}: {
  avatarMonitorOn?: boolean
  onStyleChange?: (style: CompanionAnimationStyle) => void
}) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CompanionAnimationStyle>(() => getCompanionAnimationStyle())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => onCompanionAnimationStyle(setStyle), [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = COMPANION_ANIMATION_STYLES.find((s) => s.id === style) ?? COMPANION_ANIMATION_STYLES[0]!

  const pick = (id: CompanionAnimationStyle) => {
    setCompanionAnimationStyle(id)
    setStyle(id)
    setOpen(false)
    onStyleChange?.(id)
    if (avatarMonitorOn) {
      void engineClient.avatarMonitor.syncLayout({
        collapsed: false,
        animationStyle: id
      })
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="Companion animation style"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-zinc-600 px-2 py-0.5 font-medium text-zinc-300 hover:border-indigo-500/50 hover:bg-zinc-800 hover:text-indigo-200"
      >
        ◈ {current.label}
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-[90] mt-1 min-w-[11rem] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
        >
          {COMPANION_ANIMATION_STYLES.map((opt) => (
            <li key={opt.id} role="option" aria-selected={opt.id === style}>
              <button
                type="button"
                onClick={() => pick(opt.id)}
                className={`block w-full px-3 py-1.5 text-left text-xs ${
                  opt.id === style
                    ? 'bg-indigo-600/30 text-indigo-100'
                    : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">
                  {opt.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
