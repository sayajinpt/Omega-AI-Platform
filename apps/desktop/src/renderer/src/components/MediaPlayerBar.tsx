import { useEffect, useRef, useState } from 'react'
import { engineClient } from '../lib/engine'
import {
  MEDIA_LOCAL_IDLE_EVENT,
  MEDIA_LOCAL_PAUSE_EVENT,
  MEDIA_LOCAL_RESUME_EVENT
} from '../lib/media-controls'
import { mediaStop } from '../lib/media-controls'

type NowPlaying = {
  kind: 'local' | 'youtube' | 'preview' | 'idle'
  title: string
  path?: string
  url?: string
  playing?: boolean
  embedInChat?: boolean
}

/** Compact fallback bar when YouTube mini panel is collapsed; local audio always uses hidden element here. */
export function MediaPlayerBar() {
  const [np, setNp] = useState<NowPlaying>({ kind: 'idle', title: '' })
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const onLocalIdle = () => setNp({ kind: 'idle', title: '' })
    const onLocalPause = () => setNp((p) => ({ ...p, playing: false }))
    const onLocalResume = () => setNp((p) => ({ ...p, playing: true }))
    window.addEventListener(MEDIA_LOCAL_IDLE_EVENT, onLocalIdle)
    window.addEventListener(MEDIA_LOCAL_PAUSE_EVENT, onLocalPause)
    window.addEventListener(MEDIA_LOCAL_RESUME_EVENT, onLocalResume)
    const off = engineClient.media.onState((s) =>
      setNp({
        kind: s.kind as NowPlaying['kind'],
        title: s.title,
        path: s.path,
        url: s.url,
        playing: s.playing,
        embedInChat: s.embedInChat
      })
    )
    return () => {
      off()
      window.removeEventListener(MEDIA_LOCAL_IDLE_EVENT, onLocalIdle)
      window.removeEventListener(MEDIA_LOCAL_PAUSE_EVENT, onLocalPause)
      window.removeEventListener(MEDIA_LOCAL_RESUME_EVENT, onLocalResume)
    }
  }, [])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (np.kind === 'local' && np.path) {
      const p = np.path.replace(/\\/g, '/')
      el.src = /^[a-zA-Z]:/.test(p) ? `file:///${p}` : `file://${p}`
      if (np.playing !== false) void el.play().catch(() => {})
      else el.pause()
    } else {
      el.pause()
      el.removeAttribute('src')
    }
  }, [np])

  if (np.kind === 'idle') return null
  if ((np.kind === 'youtube' || np.kind === 'preview') && np.embedInChat !== false) return null

  return (
    <div className="fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/95 px-4 py-2 text-xs shadow-lg">
      <span className="text-zinc-400">{np.kind === 'youtube' ? '▶ YouTube' : '♪'}</span>
      <span className="max-w-[240px] truncate text-zinc-200">{np.title}</span>
      {np.kind === 'local' && <audio ref={audioRef} className="hidden" />}
      <button
        type="button"
        className="rounded border border-zinc-600 px-2 py-0.5 text-zinc-400 hover:text-white"
        onClick={() => void mediaStop()}
      >
        Stop
      </button>
    </div>
  )
}
