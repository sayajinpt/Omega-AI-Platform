import { engineClient } from '../lib/engine'
import { useEffect, useState } from 'react'
import type { CapabilityPermissionRequest } from '@omega/sdk'

/**
 * In-chat card when the agent needs a Settings permission (web fetch, browser, etc.).
 */
export function ChatCapabilityApproval({ onConfigUpdated }: { onConfigUpdated?: () => void }) {
  const [req, setReq] = useState<CapabilityPermissionRequest | null>(null)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    return engineClient.permissions.onRequest((r) => {
      setReq(r)
      setRemember(false)
    })
  }, [])

  if (!req) return null

  const decide = async (approved: boolean) => {
    await engineClient.permissions.resolve(req.id, approved, remember)
    if (approved) onConfigUpdated?.()
    setReq(null)
  }

  return (
    <div
      className="omega-chat-bubble omega-chat-assistant mr-auto mb-3 w-full max-w-[min(42rem,100%)] rounded-xl border border-amber-600/50 bg-amber-950/25 px-4 py-3 shadow-lg"
      role="dialog"
      aria-label="Permission required"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-amber-300">Permission needed</p>
      <h3 className="mt-1 text-sm font-semibold text-zinc-100">{req.summary}</h3>
      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{req.detail}</p>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-zinc-500">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="rounded border-zinc-600"
        />
        Always allow permissions when the agent needs them (no more prompts)
      </label>
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
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
        >
          Allow {req.label}
        </button>
      </div>
    </div>
  )
}
