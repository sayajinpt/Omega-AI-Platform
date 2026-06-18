import type { ToolApprovalRequest } from '@omega/sdk'
import { usePendingToolApproval } from '../lib/usePendingToolApproval'

const EXTENSION_TOOLS = new Set([
  'install_plugin',
  'write_plugin',
  'create_skill',
  'extend_capability'
])

/**
 * In-chat approval when the agent wants to run a sensitive tool (run_python, run_shell, …).
 * Shown beside the composer so prompts are visible while a long chat/send is in progress.
 */
export function ChatToolApproval() {
  const { req, decide, deciding, error } = usePendingToolApproval(
    (r) => r.kind !== 'extension' && !EXTENSION_TOOLS.has(r.tool)
  )

  if (!req) return null

  return (
    <div
      className="omega-chat-bubble omega-chat-assistant mr-auto mb-3 w-full max-w-[min(42rem,100%)] rounded-xl border border-amber-600/50 bg-amber-950/25 px-4 py-3 shadow-lg"
      role="dialog"
      aria-label="Tool approval required"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-amber-300">Action needs approval</p>
      <h3 className="mt-1 text-sm font-semibold text-zinc-100">
        Allow <span className="font-mono text-amber-200">{req.tool}</span>?
      </h3>
      <p className="mt-1 text-xs text-zinc-400">
        Ωmega is paused until you approve or deny. This keeps scripts and shell commands under your control.
      </p>
      {req.rationale && (
        <p className="mt-2 rounded-lg border border-amber-700/40 bg-amber-900/20 px-2 py-1.5 text-[11px] text-amber-200">
          {req.rationale}
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-400">
          Arguments
        </summary>
        <pre className="mt-1 max-h-36 overflow-y-auto rounded-lg bg-zinc-950/80 p-2 text-[10px] text-zinc-400">
          {JSON.stringify(req.args, null, 2)}
        </pre>
      </details>
      {error && (
        <p className="mt-2 rounded-lg border border-rose-700/50 bg-rose-950/40 p-2 text-[11px] text-rose-200">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={deciding}
          onClick={() => void decide(false)}
          className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={deciding}
          onClick={() => void decide(true)}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
        >
          {deciding ? 'Sending…' : 'Approve'}
        </button>
      </div>
    </div>
  )
}
