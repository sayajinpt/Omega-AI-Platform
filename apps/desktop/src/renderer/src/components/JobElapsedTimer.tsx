import { useEffect, useMemo, useRef, useState } from 'react'

function jobTerminal(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'canceled'
}

export function formatJobElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Live elapsed timer for job cards — starts at mount or ``startedAt``, freezes when terminal. */
export function JobElapsedTimer({
  status,
  startedAt,
  completedAt,
  elapsedMs
}: {
  status?: string
  startedAt?: number
  completedAt?: number
  elapsedMs?: number
}) {
  const mountAt = useRef(Date.now())
  const startMs = startedAt && startedAt > 0 ? startedAt : mountAt.current
  const terminal = jobTerminal(status)
  const [, tick] = useState(0)

  useEffect(() => {
    if (terminal) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [terminal])

  const elapsed = useMemo(() => {
    if (typeof elapsedMs === 'number' && elapsedMs >= 0 && terminal) return elapsedMs
    if (terminal && completedAt && completedAt > startMs) return completedAt - startMs
    if (terminal) return Math.max(0, Date.now() - startMs)
    return Math.max(0, Date.now() - startMs)
  }, [elapsedMs, terminal, completedAt, startMs, tick])

  const label = terminal ? `Finished in ${formatJobElapsed(elapsed)}` : `Running ${formatJobElapsed(elapsed)}`

  return (
    <p className="mt-1 font-mono text-[11px] text-zinc-500" aria-live={terminal ? 'polite' : 'off'}>
      {label}
    </p>
  )
}
