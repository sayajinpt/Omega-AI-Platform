import { useEffect, useRef, useState } from 'react'
import type { MessagePart } from '@omega/sdk'
import { previewSessionMediaInChat } from '../lib/media-controls'
import { engineClient } from '../lib/engine'
import { JobElapsedTimer } from './JobElapsedTimer'

function jobPlayable(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded'
}

function jobTerminal(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded' || s === 'failed' || s === 'cancelled'
}

export function DirectVideoMessageCard({
  part,
  sessionId
}: {
  part: Extract<MessagePart, { type: 'direct_video' }>
  sessionId: string | null
}) {
  const [livePart, setLivePart] = useState(part)
  const [playBusy, setPlayBusy] = useState(false)
  const [playErr, setPlayErr] = useState<string | null>(null)
  const autoPlayedRef = useRef(false)

  useEffect(() => {
    setLivePart(part)
  }, [part])

  // Session DB is source of truth when push patches are missed (HTTP event poll gap, etc.).
  useEffect(() => {
    if (!sessionId || jobTerminal(livePart.status)) return
    let cancelled = false

    const syncFromSession = async () => {
      try {
        const rows = await engineClient.sessions.messages(sessionId)
        for (let i = rows.length - 1; i >= 0; i--) {
          const m = rows[i]
          if (m?.role !== 'assistant' || !m.parts?.length) continue
          const hit = m.parts.find(
            (p): p is Extract<MessagePart, { type: 'direct_video' }> =>
              p.type === 'direct_video' && p.jobId === part.jobId
          )
          if (!hit) continue
          if (!cancelled) setLivePart(hit)
          return
        }
      } catch {
        /* session read best-effort */
      }
    }

    void syncFromSession()
    const id = window.setInterval(() => void syncFromSession(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [sessionId, part.jobId, livePart.status])

  const status = livePart.status

  useEffect(() => {
    if (!sessionId || autoPlayedRef.current) return
    if (!jobPlayable(status) && !livePart.videoRef) return
    if (!livePart.videoRef) return
    autoPlayedRef.current = true
    previewSessionMediaInChat(sessionId, { type: 'video', ref: livePart.videoRef })
  }, [sessionId, status, livePart.videoRef])

  const canPlay = jobPlayable(status) && Boolean(livePart.videoRef)

  const playInChat = async () => {
    if (!sessionId || !livePart.videoRef) return
    setPlayBusy(true)
    setPlayErr(null)
    try {
      previewSessionMediaInChat(sessionId, { type: 'video', ref: livePart.videoRef })
      try {
        await engineClient.media.showPreview(sessionId, { type: 'video', ref: livePart.videoRef })
      } catch {
        /* player already open via local preview */
      }
    } catch (e) {
      setPlayErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPlayBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-violet-500/40 bg-violet-950/30 p-3 text-sm">
      <div className="font-medium text-violet-200">Text-to-video</div>
      <p className="mt-1 text-xs text-zinc-400">
        {livePart.title ?? 'Video clip'} · status: <span className="text-zinc-200">{status}</span>
      </p>
      <JobElapsedTimer
        status={status}
        startedAt={livePart.startedAt}
        completedAt={livePart.completedAt}
        elapsedMs={livePart.elapsedMs}
      />
      <p className="mt-1 font-mono text-xs text-zinc-500 break-all">job {livePart.jobId}</p>
      {livePart.error && <p className="mt-2 text-xs text-amber-400">{livePart.error}</p>}
      {playErr && <p className="mt-2 text-xs text-amber-400">{playErr}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {sessionId && (
          <button
            type="button"
            disabled={playBusy || !canPlay}
            title={!canPlay ? 'Available when generation finishes' : undefined}
            className="rounded border border-emerald-600/60 px-2.5 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            onClick={() => void playInChat()}
          >
            {playBusy ? 'Opening…' : 'Play in chat'}
          </button>
        )}
      </div>
      {!sessionId && (
        <p className="mt-2 text-xs text-zinc-500">Save this chat session to play video here.</p>
      )}
      {!jobTerminal(status) && (
        <p className="mt-2 text-xs text-zinc-500">Generating in the background…</p>
      )}
    </div>
  )
}
