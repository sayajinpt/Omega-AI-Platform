import { useEffect, useRef, useState } from 'react'
import type { MessagePart } from '@omega/sdk'
import { contentStudioJobMediaUrl } from '@omega/sdk'
import { PipelineActivityForJob } from './PipelineActivityHud'
import { JobElapsedTimer } from './JobElapsedTimer'
import { engineClient } from '../lib/engine'
import {
  previewContentStudioJobInChat,
  previewSessionMediaInChat
} from '../lib/media-controls'

function jobPlayable(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded'
}

function jobTerminal(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded' || s === 'failed' || s === 'cancelled'
}

async function probeJobMediaOnDisk(projectId: string, jobId: string): Promise<boolean> {
  try {
    const url = contentStudioJobMediaUrl(projectId, jobId)
    const res = await fetch(url, { method: 'HEAD' })
    if (res.ok) return true
    // Shell/runtime may not expose HEAD on older builds — byte-range GET is enough to confirm MP4 exists.
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    return ranged.ok || ranged.status === 206
  } catch {
    return false
  }
}

const FOCUS_KEY = 'omega.contentStudio.focusJob'

export function ContentStudioMessageCard({
  part,
  sessionId,
  onOpenStudio
}: {
  part: Extract<MessagePart, { type: 'content_studio' }>
  sessionId: string | null
  onOpenStudio?: () => void
}) {
  const [status, setStatus] = useState(part.status)
  const [busy, setBusy] = useState(false)
  const [playBusy, setPlayBusy] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [playErr, setPlayErr] = useState<string | null>(null)
  const [stopMsg, setStopMsg] = useState<string | null>(null)
  const autoPlayedRef = useRef(false)
  const pollInFlightRef = useRef(false)

  const failedRun = part.jobId === 'failed' || part.projectId === 'failed'

  useEffect(() => {
    setStatus(part.status)
    if (jobTerminal(part.status)) setErr(null)
  }, [part.status])

  useEffect(() => {
    if (failedRun || jobTerminal(part.status)) return

    let cancelled = false

    const probeDisk = async (): Promise<boolean> => {
      if (!part.projectId || !part.jobId) return false
      const ok = await probeJobMediaOnDisk(part.projectId, part.jobId)
      if (ok && !cancelled) {
        setStatus('succeeded')
        setErr(null)
      }
      return ok
    }

    let intervalId = 0
    const stopPolling = () => {
      if (intervalId) {
        window.clearInterval(intervalId)
        intervalId = 0
      }
    }

    const poll = async () => {
      if (cancelled || pollInFlightRef.current) return
      pollInFlightRef.current = true
      try {
        if (part.projectId && part.jobId) {
          const onDiskFirst = await probeJobMediaOnDisk(part.projectId, part.jobId)
          if (cancelled) return
          if (onDiskFirst) {
            setStatus('succeeded')
            setErr(null)
            stopPolling()
            return
          }
        }
        const st = await engineClient.contentStudio.runStatus(part.jobId)
        if (cancelled) return
        setStatus(st.status)
        if (st.error_message) setErr(st.error_message)
        else setErr(null)
        if (jobTerminal(st.status)) stopPolling()
      } catch (e) {
        if (cancelled) return
        const onDisk = await probeDisk()
        if (onDisk) stopPolling()
        else if (!onDisk) {
          setErr(e instanceof Error ? e.message : String(e))
        }
      } finally {
        pollInFlightRef.current = false
      }
    }

    void poll()
    intervalId = window.setInterval(() => void poll(), 10_000)
    return () => {
      cancelled = true
      stopPolling()
    }
  }, [failedRun, part.jobId, part.projectId, part.status])

  useEffect(() => {
    if (!sessionId || failedRun || autoPlayedRef.current) return
    if (!jobPlayable(status) && !part.videoRef) return
    if (!part.projectId || !part.jobId) return
    autoPlayedRef.current = true
    previewContentStudioJobInChat(sessionId, part.projectId, part.jobId, part.title)
  }, [sessionId, failedRun, status, part.videoRef, part.projectId, part.jobId, part.title])

  const canPlay = jobPlayable(status) || Boolean(part.videoRef)
  const canStop = !failedRun && !jobTerminal(status) && status !== 'stopping'

  const refresh = async () => {
    if (failedRun || jobTerminal(status)) return
    setBusy(true)
    setErr(null)
    try {
      const st = await engineClient.contentStudio.runStatus(part.jobId)
      setStatus(st.status)
      if (st.error_message) setErr(st.error_message)
    } catch (e) {
      if (part.projectId && part.jobId && (await probeJobMediaOnDisk(part.projectId, part.jobId))) {
        setStatus('succeeded')
        setErr(null)
        return
      }
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openStudio = () => {
    sessionStorage.setItem(
      FOCUS_KEY,
      JSON.stringify({ jobId: part.jobId, projectId: part.projectId })
    )
    onOpenStudio?.()
  }

  const stopGeneration = async () => {
    if (!canStop) return
    setStopBusy(true)
    setStopMsg('Stopping worker and releasing GPU…')
    setStatus('stopping')
    setErr(null)
    try {
      const r = await engineClient.contentStudio.forceStopJob({
        sessionId: sessionId ?? undefined,
        jobId: part.jobId,
        projectId: part.projectId,
        title: part.title ?? undefined
      })
      if (!r.ok) setErr(r.message)
      else {
        if (r.phase === 'cancelled') setStatus('cancelled')
        else if (r.phase === 'stopping') setStatus('stopping')
        setStopMsg(r.message)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setStopBusy(false)
    }
  }

  const openVideoInChat = async (): Promise<boolean> => {
    if (!sessionId || failedRun) return false

    // Open player immediately from Content Studio storage (final.mp4 on disk).
    if (canPlay && part.projectId && part.jobId) {
      previewContentStudioJobInChat(sessionId, part.projectId, part.jobId, part.title)
    } else if (part.videoRef) {
      previewSessionMediaInChat(sessionId, { type: 'video', ref: part.videoRef })
    } else {
      setPlayErr('Video is not ready yet')
      return false
    }

    // Best-effort sync with runtime media state (may fail during model reload).
    try {
      if (part.videoRef) {
        const r = await engineClient.media.showPreview(sessionId, {
          type: 'video',
          ref: part.videoRef
        })
        if (r.ok) return true
      }
    } catch {
      /* player already open via local preview */
    }
    try {
      const r = await engineClient.media.reopenSessionVideo(sessionId, part.jobId)
      if (r.ok) return true
    } catch {
      /* player already open via local preview */
    }
    return true
  }

  const playInChat = async () => {
    if (!sessionId || failedRun) return
    setPlayBusy(true)
    setPlayErr(null)
    try {
      await openVideoInChat()
    } finally {
      setPlayBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-indigo-500/40 bg-indigo-950/30 p-3 text-sm">
      <div className="font-medium text-indigo-200">Content Studio</div>
      <p className="mt-1 text-xs text-zinc-400">
        {part.title ?? 'Video project'} · status: <span className="text-zinc-200">{status}</span>
      </p>
      <JobElapsedTimer
        status={status}
        startedAt={part.startedAt}
        completedAt={part.completedAt}
        elapsedMs={part.elapsedMs}
      />
      {!failedRun && !jobTerminal(status) && (
        <div className="mt-2">
          <PipelineActivityForJob jobId={part.jobId} />
        </div>
      )}
      {!failedRun && (
        <p className="mt-1 font-mono text-xs text-zinc-500 break-all">
          job {part.jobId}
          <br />
          project {part.projectId}
        </p>
      )}
      {part.youtubeUrl && (
        <a
          href={part.youtubeUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs text-indigo-400 hover:underline"
        >
          YouTube link
        </a>
      )}
      {err && <p className="mt-2 text-xs text-amber-400">{err}</p>}
      {playErr && <p className="mt-2 text-xs text-amber-400">{playErr}</p>}
      {stopMsg && <p className="mt-2 text-xs text-zinc-400">{stopMsg}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {canStop && (
          <button
            type="button"
            disabled={stopBusy}
            className="rounded border border-red-600/60 px-2.5 py-1 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-50"
            onClick={() => void stopGeneration()}
          >
            {stopBusy ? 'Stopping…' : 'Stop generation'}
          </button>
        )}
        {sessionId && !failedRun && (
          <button
            type="button"
            disabled={playBusy || !canPlay}
            title={!canPlay ? 'Available when the job finishes' : undefined}
            className="rounded border border-emerald-600/60 px-2.5 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            onClick={() => void playInChat()}
          >
            {playBusy ? 'Opening…' : 'Play in chat'}
          </button>
        )}
        <button
          type="button"
          className="rounded border border-indigo-500/60 px-2.5 py-1 text-xs text-indigo-200 hover:bg-indigo-500/20"
          onClick={() => openStudio()}
        >
          Open Content Studio
        </button>
        {!failedRun && (
          <button
            type="button"
            disabled={busy}
            className="rounded border border-zinc-600 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            onClick={() => void refresh()}
          >
            {busy ? 'Checking…' : 'Refresh status'}
          </button>
        )}
      </div>
      {!sessionId && (
        <p className="mt-2 text-xs text-zinc-500">Save this chat session to attach playable video here.</p>
      )}
    </div>
  )
}

export function readContentStudioFocus(): { jobId: string; projectId: string } | null {
  try {
    const raw = sessionStorage.getItem(FOCUS_KEY)
    if (!raw) return null
    const j = JSON.parse(raw) as { jobId?: string; projectId?: string }
    if (j.jobId && j.projectId) return { jobId: j.jobId, projectId: j.projectId }
  } catch {
    /* ignore */
  }
  return null
}

export function clearContentStudioFocus(): void {
  sessionStorage.removeItem(FOCUS_KEY)
}
