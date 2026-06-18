import { useEffect, useMemo, useState } from 'react'

const PREVIEW_CHARS = 120

export function ThinkingPanel({
  thinking,
  thinkingOpen,
  streaming
}: {
  thinking: string
  /** Model still emitting thought tokens (no closing tag yet). */
  thinkingOpen?: boolean
  streaming?: boolean
}) {
  const live = Boolean(streaming && thinkingOpen)
  const [expanded, setExpanded] = useState(live)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    if (live) setExpanded(true)
  }, [live])

  const preview = useMemo(() => {
    const t = thinking.replace(/\s+/g, ' ').trim()
    if (!t) return live ? 'Model is reasoning…' : 'No visible chain-of-thought text'
    if (t.length <= PREVIEW_CHARS) return t
    return `${t.slice(0, PREVIEW_CHARS)}…`
  }, [thinking, live])

  return (
    <>
      <div
        className={`mb-2 rounded-lg border text-xs shadow-sm ${
          live
            ? 'border-violet-500/50 bg-violet-950/35 ring-1 ring-violet-500/20'
            : 'border-zinc-600/70 bg-zinc-900/80'
        }`}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        >
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm ${
              live ? 'bg-violet-800/60 text-violet-200' : 'bg-zinc-800 text-zinc-400'
            }`}
            aria-hidden
          >
            💭
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block text-[10px] font-semibold uppercase tracking-wide ${
                live ? 'text-violet-300' : 'text-zinc-400'
              }`}
            >
              {live ? 'Thinking…' : 'Chain of thought'}
            </span>
            {!expanded && (
              <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">{preview}</span>
            )}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-500">{expanded ? 'Hide' : 'Read'}</span>
        </button>

        {expanded && (
          <div className="border-t border-zinc-700/80 px-2.5 py-2">
            <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
              {thinking.trim() || (live ? '…' : '(empty)')}
            </pre>
            {(thinking.trim().length > PREVIEW_CHARS || modalOpen) && (
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="mt-2 text-[10px] text-indigo-300 hover:underline"
              >
                Open full view
              </button>
            )}
          </div>
        )}
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Full thinking"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="flex max-h-[min(80vh,640px)] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
              <h3 className="text-sm font-medium text-zinc-200">Chain of thought</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Close
              </button>
            </header>
            <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-zinc-300">
              {thinking.trim() || '(empty)'}
            </pre>
          </div>
        </div>
      )}
    </>
  )
}
