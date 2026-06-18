import { createPortal } from 'react-dom'
import { usePendingToolApproval } from '../lib/usePendingToolApproval'

/** Full-screen overlay for tool approval outside chat (chat uses ChatToolApproval). */
export function ToolApprovalModal() {
  const { req, decide, deciding, error } = usePendingToolApproval(
    (r) => r.kind !== 'extension' && r.kind !== 'general'
  )

  if (!req) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tool-approval-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-amber-700 bg-zinc-900 p-6 shadow-2xl">
        <h3 id="tool-approval-title" className="text-lg font-semibold text-amber-300">
          Tool approval required
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Ωmega wants to run <span className="font-mono text-amber-200">{req.tool}</span> with:
        </p>
        <pre className="mt-3 max-h-48 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
          {JSON.stringify(req.args, null, 2)}
        </pre>
        {req.rationale && (
          <p className="mt-2 rounded-lg border border-amber-700/40 bg-amber-900/20 p-2 text-xs text-amber-200">
            {req.rationale}
          </p>
        )}
        {error && (
          <p className="mt-2 rounded-lg border border-rose-700/50 bg-rose-950/40 p-2 text-xs text-rose-200">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={deciding}
            onClick={() => void decide(false)}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => void decide(true)}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {deciding ? 'Sending…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
