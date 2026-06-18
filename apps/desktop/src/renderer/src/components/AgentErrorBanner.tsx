import type { AgentErrorHint } from '../lib/agent-errors'
import type { Page } from '../App'

export function AgentErrorBanner({
  hint,
  onNavigate,
  onDismiss
}: {
  hint: AgentErrorHint
  onNavigate?: (page: Page) => void
  onDismiss?: () => void
}) {
  return (
    <div className="rounded-lg border border-rose-800/80 bg-rose-950/50 px-3 py-2 text-xs text-rose-100">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-rose-200">{hint.title}</p>
          <p className="mt-1 whitespace-pre-wrap text-rose-100/90">{hint.message}</p>
          {hint.actions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {hint.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  title={a.hint}
                  onClick={() => a.page && onNavigate?.(a.page as Page)}
                  className="rounded border border-rose-700/60 bg-rose-900/40 px-2 py-0.5 text-[10px] text-rose-100 hover:bg-rose-900/70"
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 text-rose-400 hover:text-rose-200"
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
