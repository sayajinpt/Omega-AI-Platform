import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_NATIVE_RUNTIME_PORT, nativeRuntimeBaseUrl, type ToolApprovalRequest } from '@omega/sdk'
import { engineClient } from './engine'

async function fetchPendingToolApprovals(): Promise<ToolApprovalRequest[]> {
  const res = await fetch(`${nativeRuntimeBaseUrl(DEFAULT_NATIVE_RUNTIME_PORT)}/v1/tool/approve/pending`, {
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) return []
  const body = (await res.json()) as unknown
  return Array.isArray(body) ? (body as ToolApprovalRequest[]) : []
}

function pickNewestPending(items: ToolApprovalRequest[]): ToolApprovalRequest | null {
  if (items.length === 0) return null
  let best = items[0]!
  let bestAt = typeof (best as { createdAt?: number }).createdAt === 'number' ? (best as { createdAt: number }).createdAt : 0
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!
    const at = typeof (item as { createdAt?: number }).createdAt === 'number' ? (item as { createdAt: number }).createdAt : 0
    if (at >= bestAt) {
      best = item
      bestAt = at
    }
  }
  return best
}

export function usePendingToolApproval(
  accept: (req: ToolApprovalRequest) => boolean
): {
  req: ToolApprovalRequest | null
  setReq: (req: ToolApprovalRequest | null) => void
  refreshPending: () => Promise<void>
  decide: (approved: boolean) => Promise<{ ok: boolean; expired?: boolean }>
  deciding: boolean
  error: string | null
} {
  const [req, setReq] = useState<ToolApprovalRequest | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const acceptRef = useRef(accept)
  acceptRef.current = accept

  const refreshPending = useCallback(async () => {
    const pending = await fetchPendingToolApprovals()
    const filtered = pending.filter((p) => acceptRef.current(p))
    const next = pickNewestPending(filtered)
    setReq(next)
    if (!next) setError(null)
  }, [])

  useEffect(() => {
    void refreshPending()
    const unsub = engineClient.tools.onApproveRequest((r) => {
      if (!acceptRef.current(r)) return
      setReq(r)
      setError(null)
    })
    const timer = window.setInterval(() => {
      void refreshPending()
    }, 1200)
    return () => {
      unsub()
      window.clearInterval(timer)
    }
  }, [refreshPending])

  const decide = useCallback(
    async (approved: boolean): Promise<{ ok: boolean; expired?: boolean }> => {
      if (!req || deciding) return { ok: false }
      setDeciding(true)
      setError(null)
      try {
        await engineClient.tools.approve(req.id, approved)
        setReq(null)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const expired = /not found|expired|timed out/i.test(msg)
        if (expired) {
          await refreshPending()
          if (!approved) {
            setReq(null)
            return { ok: true, expired: true }
          }
          setError('That approval expired — ask Ωmega to run the tool again, or approve sooner when prompted.')
          return { ok: false, expired: true }
        }
        setError(msg)
        return { ok: false }
      } finally {
        setDeciding(false)
      }
    },
    [req, deciding, refreshPending]
  )

  return { req, setReq, refreshPending, decide, deciding, error }
}
