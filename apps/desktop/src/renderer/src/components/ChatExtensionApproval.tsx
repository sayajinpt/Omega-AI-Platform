import { engineClient } from '../lib/engine'
import { useEffect, useState } from 'react'
import type { ToolApprovalRequest } from '@omega/sdk'

const EXTENSION_TOOLS = new Set([
  'install_plugin',
  'write_plugin',
  'create_skill',
  'extend_capability'
])

/**
 * In-chat approval card when the agent wants to extend itself (plugins / skills).
 */
export function ChatExtensionApproval() {
  const [req, setReq] = useState<ToolApprovalRequest | null>(null)

  useEffect(() => {
    return engineClient.tools.onApproveRequest((r) => {
      if (r.kind === 'extension' || EXTENSION_TOOLS.has(r.tool)) {
        setReq({ ...r, kind: 'extension' })
      }
    })
  }, [])

  if (!req) return null

  const decide = async (approved: boolean) => {
    await engineClient.tools.approve(req.id, approved)
    setReq(null)
  }

  return (
    <div
      className="omega-chat-bubble omega-chat-assistant mr-auto mb-3 w-full max-w-[min(42rem,100%)] rounded-xl border border-violet-600/50 bg-violet-950/30 px-4 py-3 shadow-lg"
      role="dialog"
      aria-label="Agent extension approval"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-violet-300">Agent self-extension</p>
      <h3 className="mt-1 text-sm font-semibold text-zinc-100">
        {req.summary ?? `Allow ${req.tool}?`}
      </h3>
      {req.detail && (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{req.detail}</p>
      )}
      {req.rationale && (
        <p className="mt-2 rounded-lg border border-violet-700/40 bg-violet-900/20 px-2 py-1.5 text-[11px] text-violet-200">
          {req.rationale}
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-400">
          Technical details ({req.tool})
        </summary>
        <pre className="mt-1 max-h-36 overflow-y-auto rounded-lg bg-zinc-950/80 p-2 text-[10px] text-zinc-400">
          {JSON.stringify(req.args, null, 2)}
        </pre>
      </details>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => void decide(false)}
          className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => void decide(true)}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
        >
          Approve extension
        </button>
      </div>
    </div>
  )
}
