import { useEffect, useState } from 'react'
import { engineClient } from '../lib/engine'
import {
  MEDIA_LOCAL_IDLE_EVENT,
  MEDIA_LOCAL_PAUSE_EVENT,
  MEDIA_LOCAL_RESUME_EVENT,
  mediaPause,
  mediaResume,
  mediaStop
} from '../lib/media-controls'

type MediaState = {
  kind: string
  title: string
  playing?: boolean
  previewType?: string
}

/** Top-bar transport for any active Omega media (local audio or embedded browser / YouTube). */
export function GlobalMediaControls() {
  const [media, setMedia] = useState<MediaState | null>(null)

  useEffect(() => {
    const onLocalIdle = () => setMedia(null)
    const onLocalPause = () => setMedia((m) => (m ? { ...m, playing: false } : m))
    const onLocalResume = () => setMedia((m) => (m ? { ...m, playing: true } : m))
    window.addEventListener(MEDIA_LOCAL_IDLE_EVENT, onLocalIdle)
    window.addEventListener(MEDIA_LOCAL_PAUSE_EVENT, onLocalPause)
    window.addEventListener(MEDIA_LOCAL_RESUME_EVENT, onLocalResume)
    const off = engineClient.media.onState((s) => {
      if (s.kind === 'idle') setMedia(null)
      else
        setMedia({
          kind: s.kind,
          title: s.title,
          playing: s.playing,
          previewType: (s as MediaState).previewType
        })
    })
    return () => {
      off()
      window.removeEventListener(MEDIA_LOCAL_IDLE_EVENT, onLocalIdle)
      window.removeEventListener(MEDIA_LOCAL_PAUSE_EVENT, onLocalPause)
      window.removeEventListener(MEDIA_LOCAL_RESUME_EVENT, onLocalResume)
    }
  }, [])

  if (!media || media.kind === 'idle') return null

  const playing = media.playing !== false
  const label =
    media.kind === 'youtube'
      ? 'YouTube'
      : media.kind === 'local'
        ? 'Audio'
        : media.kind === 'preview'
          ? media.previewType === 'image'
            ? 'Image'
            : media.previewType === 'video'
              ? 'Video'
              : media.previewType === 'audio'
                ? 'Audio'
                : 'Review'
          : 'Media'

  const canTransport =
    media.kind === 'local' ||
    media.kind === 'youtube' ||
    media.previewType === 'video' ||
    media.previewType === 'audio' ||
    media.previewType === 'web'

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2 py-0.5">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="max-w-[140px] truncate text-[11px] text-zinc-300" title={media.title}>
        {media.title}
      </span>
      {canTransport && (
        <button
          type="button"
          title={playing ? 'Pause' : 'Play'}
          className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-800"
          onClick={() => void (playing ? mediaPause() : mediaResume())}
        >
          {playing ? '⏸' : '▶'}
        </button>
      )}
      <button
        type="button"
        title="Stop"
        className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-rose-300 hover:bg-zinc-800"
        onClick={() => void mediaStop()}
      >
        ⏹
      </button>
    </div>
  )
}
