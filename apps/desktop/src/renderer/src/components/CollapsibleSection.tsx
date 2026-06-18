import { useState, type ReactNode } from 'react'

export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  badge,
  children,
  compact = false,
  minBodyHeight = 180,
  maxBodyHeight = 480,
  compactExpandedMaxHeight = 360
}: {
  title: string
  subtitle?: string
  defaultOpen?: boolean
  badge?: ReactNode
  compact?: boolean
  children: ReactNode
  /** Minimum body height (px) when expanded (non-compact). */
  minBodyHeight?: number
  maxBodyHeight?: number
  /** Max body height when compact + expanded. */
  compactExpandedMaxHeight?: number
}) {
  const [open, setOpen] = useState(defaultOpen)
  const light =
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'

  const collapsedCompact = compact && !open

  return (
    <section
      className={`flex flex-col border ${
        collapsedCompact
          ? 'rounded-md'
          : 'rounded-xl'
      } ${light ? 'border-zinc-300 bg-white/90' : 'border-zinc-800 bg-zinc-900/40'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full shrink-0 items-center gap-1.5 text-left transition ${
          collapsedCompact
            ? 'px-2 py-0.5'
            : compact
              ? 'px-2 py-1.5'
              : 'px-4 py-3'
        } ${light ? 'hover:bg-zinc-100' : 'hover:bg-zinc-800/50'}`}
      >
        <span
          className={`shrink-0 text-zinc-500 ${collapsedCompact ? 'text-[9px]' : compact ? 'text-[10px]' : 'text-xs'}`}
        >
          {open ? '▼' : '▶'}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {collapsedCompact ? (
            <span className="text-[10px] font-medium text-zinc-400">{title}</span>
          ) : (
            <>
              <span
                className={`font-semibold uppercase tracking-wide ${
                  compact ? 'text-[10px]' : 'text-xs'
                } ${light ? 'text-zinc-700' : 'text-zinc-300'}`}
              >
                {title}
              </span>
              {subtitle && !open && (
                <span className="ml-2 truncate text-[10px] text-zinc-500">{subtitle}</span>
              )}
            </>
          )}
        </span>
        {badge}
      </button>
      {open && (
        <div
          className={`shrink-0 border-t ${compact ? 'px-2 py-2' : 'px-4 py-3'} ${
            light ? 'border-zinc-200' : 'border-zinc-800/80'
          }`}
          style={{
            minHeight: compact ? 96 : minBodyHeight,
            maxHeight: compact ? compactExpandedMaxHeight : maxBodyHeight,
            resize: 'vertical',
            overflowX: 'hidden',
            overflowY: 'auto'
          }}
        >
          {children}
        </div>
      )}
    </section>
  )
}
