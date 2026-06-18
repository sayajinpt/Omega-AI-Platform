import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { engineClient } from './engine'

export type DownloadJob = {
  repo: string
  filename: string
  percent: number
  status: string
  detail?: string
  speed_bps: number
  bytes_done?: number
  bytes_total?: number
}

export function downloadJobPercent(job: DownloadJob): number {
  const done = job.bytes_done ?? 0
  const total = job.bytes_total ?? 0
  if (total > 0 && done > 0) {
    return Math.min(100, (100 * done) / total)
  }
  return job.percent ?? 0
}

function mergeDownloadProgress(
  prev: DownloadJob[],
  prog: DownloadJob & { filename: string; repo: string; detail?: string }
): DownloadJob[] {
  const idx = prev.findIndex((j) => j.repo === prog.repo && j.filename === prog.filename)
  const next = [...prev]
  const prior = idx >= 0 ? prev[idx] : undefined
  const bytes_done = Math.max(prog.bytes_done ?? 0, prior?.bytes_done ?? 0)
  const bytes_total = Math.max(prog.bytes_total ?? 0, prior?.bytes_total ?? 0)
  let percent = prog.percent ?? 0
  if (bytes_total > 0 && bytes_done > 0) {
    percent = Math.max(percent, Math.min(99.9, (100 * bytes_done) / bytes_total))
  } else {
    percent = Math.max(prior?.percent ?? 0, percent)
  }
  const row: DownloadJob = {
    repo: prog.repo,
    filename: prog.filename,
    percent,
    status: prog.status ?? prior?.status ?? '',
    detail: prog.detail ?? prior?.detail,
    speed_bps: prog.speed_bps ?? prior?.speed_bps ?? 0,
    bytes_done,
    bytes_total
  }
  if (idx >= 0) next[idx] = row
  else next.push(row)
  const st = (row.status ?? '').toLowerCase()
  if (st === 'complete' || st === 'cancelled' || st === 'error') {
    return next.filter((j) => {
      const jst = (j.status ?? '').toLowerCase()
      return jst !== 'complete' && jst !== 'cancelled' && jst !== 'error'
    })
  }
  return next
}

/** Shared Model Studio download queue (GGUF + Content Studio snapshot downloads). */
export function useDownloadQueue(): [DownloadJob[], Dispatch<SetStateAction<DownloadJob[]>>] {
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const pendingRef = useRef<DownloadJob[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const flush = () => {
      flushTimerRef.current = null
      setJobs([...pendingRef.current])
    }

    const off = engineClient.models.onDownloadProgress((p) => {
      const prog = p as DownloadJob & { filename: string; repo: string }
      pendingRef.current = mergeDownloadProgress(pendingRef.current, prog)
      const st = (prog.status ?? '').toLowerCase()
      const terminal = st === 'complete' || st === 'error' || st === 'cancelled'
      if (terminal) {
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
        flush()
        return
      }
      if (flushTimerRef.current) return
      flushTimerRef.current = setTimeout(flush, 250)
    })
    return () => {
      off()
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    }
  }, [])

  const setJobsSynced = useCallback<Dispatch<SetStateAction<DownloadJob[]>>>((action) => {
    setJobs((prev) => {
      const next = typeof action === 'function' ? action(prev) : action
      pendingRef.current = next
      return next
    })
  }, [])

  return [jobs, setJobsSynced]
}
