import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BrowserStatus } from '@omega/sdk'
import { sessionMediaUrl } from '@omega/sdk'
import { engineClient } from '../lib/engine'
import { fetchMediaPlayerState, type MediaPlayerState } from '../lib/fetch-media-state'
import {
  MEDIA_LOCAL_IDLE_EVENT,
  MEDIA_LOCAL_PAUSE_EVENT,
  MEDIA_LOCAL_PREVIEW_EVENT,
  MEDIA_LOCAL_RESUME_EVENT,
  mediaPause,
  mediaResume,
  mediaStop
} from '../lib/media-controls'
import { domRectToShellBounds } from '../lib/browser-bounds'
import {
  boundsFromElement,
  placeEmbeddedBrowser,
  scheduleBoundsSettle
} from '../lib/browser-placement'

type MediaState = MediaPlayerState

/** Compact embed inside a chat bubble. */
const MINI_HEIGHT = 300
const MINI_MAX_WIDTH = 720

const BUBBLE_CLASS =
  'omega-chat-bubble omega-chat-assistant mr-auto mb-3 w-full max-w-[min(48rem,100%)] rounded-xl px-4 py-2.5 shadow-sm'

function localFileSrc(filePath: string): string {
  const p = filePath.replace(/\\/g, '/')
  return /^[a-zA-Z]:/.test(p) ? `file:///${p}` : `file://${p}`
}

function panelLabel(media: MediaState): string {
  if (media.kind === 'youtube') return 'YouTube'
  if (media.previewType === 'image') return 'Image review'
  if (media.previewType === 'video') return 'Video review'
  if (media.previewType === 'audio') return 'Audio review'
  if (media.previewType === 'web') return 'Page review'
  if (media.previewType === 'file') return 'File'
  return 'Media'
}

function usesBrowserSurface(media: MediaState): boolean {
  if (media.kind === 'youtube') {
    return Boolean((media.embedUrl ?? media.watchUrl ?? media.url ?? '').trim())
  }
  return media.previewType === 'web'
}

/**
 * Chat mini panel: YouTube/web in embedded BrowserView; model images/video/audio via session media.
 * Rendered as an assistant-style message bubble inside the scroll area.
 */
export function ChatMediaReviewPanel({
  chatActive,
  overlayEpoch = 0,
  suppressInlineYoutube = false,
  onOpenBrowser,
  onVisible
}: {
  chatActive: boolean
  /** Bumped when session changes or chat is deleted — clears embed and BrowserView. */
  overlayEpoch?: number
  /** When the assistant bubble already hosts YouTube, skip the duplicate MEDIA row. */
  suppressInlineYoutube?: boolean
  onOpenBrowser?: () => void
  /** Fired once when expanded in-chat player mounts or switches to new media. */
  onVisible?: (mediaKey: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [media, setMedia] = useState<MediaState | null>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const revealedKeyRef = useRef<string | null>(null)
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible

  const hasEmbedMedia =
    chatActive &&
    media &&
    media.embedInChat !== false &&
    (media.kind === 'youtube' || media.kind === 'preview')

  const showExpandedPanel = hasEmbedMedia && !collapsed
  const youtubeNavigateUrl =
    media?.kind === 'youtube'
      ? (media.watchUrl ?? media.url ?? media.embedUrl ?? '').trim()
      : ''
  const showBrowserHost =
    showExpandedPanel &&
    media &&
    (media.kind === 'youtube' ? Boolean(youtubeNavigateUrl) : usesBrowserSurface(media))

  const syncBounds = useCallback(() => {
    const el = hostRef.current
    if (!el || !showBrowserHost) return
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return
    void engineClient.browser.setBounds(domRectToShellBounds(r))
  }, [showBrowserHost])

  useEffect(() => {
    if (!chatActive) {
      setMedia(null)
      setCollapsed(false)
      void engineClient.browser.hide()
    }
  }, [chatActive])

  useEffect(() => {
    setMedia(null)
    setCollapsed(false)
    void engineClient.browser.hide()
  }, [overlayEpoch])

  useEffect(() => {
    if (!chatActive) return
    void fetchMediaPlayerState().then((s) => {
      if (s) setMedia(s)
    })
  }, [chatActive, overlayEpoch])

  useEffect(() => {
    const onLocalIdle = () => {
      setMedia(null)
      setCollapsed(false)
      videoRef.current?.pause()
      if (videoRef.current) videoRef.current.removeAttribute('src')
      audioRef.current?.pause()
      if (audioRef.current) audioRef.current.removeAttribute('src')
      void engineClient.browser.hide()
    }
    const onLocalPause = () => {
      videoRef.current?.pause()
      audioRef.current?.pause()
      setMedia((m) => (m ? { ...m, playing: false } : m))
    }
    const onLocalResume = () => {
      const v = videoRef.current
      const a = audioRef.current
      if (v) void v.play().catch(() => {})
      if (a) void a.play().catch(() => {})
      setMedia((m) => (m ? { ...m, playing: true } : m))
    }
    const onLocalPreview = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as MediaState
      if (!detail || detail.kind !== 'preview') return
      setCollapsed(false)
      setMedia(detail)
    }
    window.addEventListener(MEDIA_LOCAL_IDLE_EVENT, onLocalIdle)
    window.addEventListener(MEDIA_LOCAL_PAUSE_EVENT, onLocalPause)
    window.addEventListener(MEDIA_LOCAL_RESUME_EVENT, onLocalResume)
    window.addEventListener(MEDIA_LOCAL_PREVIEW_EVENT, onLocalPreview)
    const off = engineClient.media.onState((s) => {
      const next = s as MediaState
      if (next.kind === 'idle') {
        setMedia(null)
        void engineClient.browser.hide()
        return
      }
      setMedia((prev) => {
        const changed =
          !prev ||
          prev.kind !== next.kind ||
          prev.url !== next.url ||
          prev.sessionId !== next.sessionId ||
          prev.mediaRef !== next.mediaRef
        if (changed && next.embedInChat !== false) setCollapsed(false)
        if (prev?.directUrl && !next.directUrl) {
          return { ...next, directUrl: prev.directUrl }
        }
        return next
      })
    })
    return () => {
      off()
      window.removeEventListener(MEDIA_LOCAL_IDLE_EVENT, onLocalIdle)
      window.removeEventListener(MEDIA_LOCAL_PAUSE_EVENT, onLocalPause)
      window.removeEventListener(MEDIA_LOCAL_RESUME_EVENT, onLocalResume)
      window.removeEventListener(MEDIA_LOCAL_PREVIEW_EVENT, onLocalPreview)
    }
  }, [])

  useEffect(() => {
    return engineClient.browser.onStatus(setStatus)
  }, [])

  const sessionAvSrc =
    media?.sessionId && media.mediaRef
      ? sessionMediaUrl(media.sessionId, media.mediaRef)
      : null
  const diskAvSrc = media?.path ? localFileSrc(media.path) : null
  const avSrc = useMemo(
    () => media?.directUrl ?? sessionAvSrc ?? diskAvSrc,
    [media?.directUrl, sessionAvSrc, diskAvSrc]
  )

  useEffect(() => {
    const v = videoRef.current
    const a = audioRef.current
    if (!media || media.kind !== 'preview' || !avSrc) return
    if (media.previewType === 'video' && v) {
      v.load()
      if (media.playing !== false) void v.play().catch(() => {})
      else v.pause()
    }
    if (media.previewType === 'audio' && a) {
      a.load()
      if (media.playing !== false) void a.play().catch(() => {})
      else a.pause()
    }
  }, [media, avSrc])

  const mediaRevealKey = media
    ? [media.kind, media.sessionId, media.mediaRef, media.directUrl, media.url, media.path]
        .filter(Boolean)
        .join('|')
    : ''

  useLayoutEffect(() => {
    if (!showExpandedPanel || !mediaRevealKey) {
      if (!showExpandedPanel) revealedKeyRef.current = null
      return
    }
    if (revealedKeyRef.current === mediaRevealKey) return
    revealedKeyRef.current = mediaRevealKey
    onVisibleRef.current?.(mediaRevealKey)
  }, [showExpandedPanel, mediaRevealKey])

  useEffect(() => {
    const el = hostRef.current
    if (!showBrowserHost || !el || !media?.url) return

    const navigateTarget =
      media.kind === 'youtube'
        ? youtubeNavigateUrl
        : (media.url ?? '').trim()
    if (!navigateTarget) return
    let cancelled = false
    const settleTimers: number[] = []

    void placeEmbeddedBrowser(el, navigateTarget, 'mini', 280, 200).then(() => {
      if (cancelled) return
      settleTimers.push(
        ...scheduleBoundsSettle(
          () => boundsFromElement(el, 280, 200),
          () => cancelled
        )
      )
    })

    const ro = new ResizeObserver(() => syncBounds())
    ro.observe(el)
    window.addEventListener('resize', syncBounds)

    return () => {
      cancelled = true
      for (const t of settleTimers) window.clearTimeout(t)
      ro.disconnect()
      window.removeEventListener('resize', syncBounds)
      void engineClient.browser.hide()
    }
  }, [showBrowserHost, syncBounds, media?.url, media?.watchUrl, media?.embedUrl, media?.kind, youtubeNavigateUrl])

  useEffect(() => {
    if (!hasEmbedMedia || showBrowserHost) return
    void engineClient.browser.hide()
  }, [hasEmbedMedia, showBrowserHost])

  const openExpanded = (): void => {
    if (!media) return
    setCollapsed(true)
    void engineClient.browser.hide()
    if (media.kind === 'youtube' && (media.watchUrl || media.url)) {
      void engineClient.browser.navigate(media.watchUrl ?? media.url!)
    } else if (media.directUrl) {
      void engineClient.browser.navigate(media.directUrl)
    } else if (media.sessionId && media.mediaRef) {
      void engineClient.browser.navigate(sessionMediaUrl(media.sessionId, media.mediaRef))
    } else if (media.url) {
      void engineClient.browser.navigate(media.url)
    } else if (media.path) {
      const p = media.path.replace(/\\/g, '/')
      const fileUrl = /^[a-zA-Z]:/.test(p) ? `file:///${p}` : `file://${p}`
      void engineClient.browser.navigate(fileUrl)
    }
    onOpenBrowser?.()
  }

  const canTransport =
    media &&
    (media.previewType === 'video' ||
      media.previewType === 'audio' ||
      (media.previewType === 'web' && media.kind !== 'youtube'))

  if (!hasEmbedMedia || !media) return null
  if (suppressInlineYoutube && media.kind === 'youtube') return null

  if (collapsed) {
    return (
      <div className={BUBBLE_CLASS} role="region" aria-label="Media player minimized">
        <div className="mb-0.5 flex items-center justify-between gap-2">
          <span className="text-xs uppercase text-zinc-500">media</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm text-zinc-300">
            {panelLabel(media)}: {media.title}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-indigo-600/50 bg-indigo-950/40 px-2.5 py-1 text-xs text-indigo-200 hover:bg-indigo-900/50"
            onClick={() => setCollapsed(false)}
          >
            Show player
          </button>
        </div>
      </div>
    )
  }

  const previewBody =
    media.kind === 'preview' && avSrc ? (
      media.previewType === 'image' ? (
        <img src={avSrc} alt={media.title} className="max-h-full max-w-full object-contain" />
      ) : media.previewType === 'video' ? (
        <video
          key={avSrc}
          ref={videoRef}
          controls
          preload="metadata"
          className="h-full w-full object-contain"
          src={avSrc}
        >
          <track kind="captions" />
        </video>
      ) : media.previewType === 'audio' ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-2">
          <span className="text-4xl text-indigo-400/80">♪</span>
          <audio ref={audioRef} controls className="w-full max-w-md" src={avSrc}>
            <track kind="captions" />
          </audio>
        </div>
      ) : media.previewType === 'file' && sessionAvSrc ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
          <p className="text-sm text-zinc-300">{media.title}</p>
          <a
            href={sessionAvSrc}
            download
            className="rounded-lg border border-indigo-600/50 bg-indigo-950/40 px-3 py-1.5 text-xs text-indigo-200 hover:bg-indigo-900/50"
          >
            Download file
          </a>
        </div>
      ) : null
    ) : null

  return (
    <div className={BUBBLE_CLASS} role="region" aria-label="Media review">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs uppercase text-zinc-500">media</span>
        <div className="flex shrink-0 items-center gap-0.5">
          {canTransport && (
            <button
              type="button"
              title={media.playing !== false ? 'Pause' : 'Play'}
              className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={() => void (media.playing !== false ? mediaPause() : mediaResume())}
            >
              {media.playing !== false ? 'Pause' : 'Play'}
            </button>
          )}
          <button
            type="button"
            title="Open in full Browser tab"
            className="rounded px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-zinc-800 hover:text-indigo-100"
            onClick={openExpanded}
          >
            {media.kind === 'youtube' ? 'Browser tab' : 'Expand'}
          </button>
          <button
            type="button"
            title="Minimize panel"
            className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
            onClick={() => {
              setCollapsed(true)
              void engineClient.browser.hide()
            }}
          >
            −
          </button>
          <button
            type="button"
            title="Close review panel"
            className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-rose-300"
            onClick={() => void mediaStop()}
          >
            ×
          </button>
        </div>
      </div>

      <p className="mb-2 truncate text-xs text-zinc-400">
        {status?.loading && usesBrowserSurface(media)
          ? 'Loading…'
          : status?.title || media.title}
      </p>

      <div className="w-full max-w-full">
        {showBrowserHost ? (
          <div
            ref={hostRef}
            className="w-full overflow-hidden rounded-lg bg-black ring-1 ring-zinc-700/60"
            style={{ height: MINI_HEIGHT }}
            aria-label="Embedded browser"
          />
        ) : media.kind === 'youtube' ? (
          <div
            className="flex flex-col items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 text-center ring-1 ring-zinc-700/60"
            style={{ height: MINI_HEIGHT }}
          >
            <p className="text-xs text-zinc-400">
              No single video yet — open search in the Browser tab and pick a track.
            </p>
            <button
              type="button"
              className="rounded-lg border border-indigo-600/50 bg-indigo-950/40 px-2.5 py-1 text-xs text-indigo-200 hover:bg-indigo-900/50"
              onClick={openExpanded}
            >
              Open in Browser
            </button>
          </div>
        ) : (
          <div
            className="flex w-full items-center justify-center overflow-hidden rounded-lg bg-black ring-1 ring-zinc-700/60"
            style={{ height: MINI_HEIGHT }}
            aria-label="Media review"
          >
            {previewBody}
          </div>
        )}

        <p className="mt-2 text-[10px] leading-snug text-zinc-500">
          {media.path && !media.sessionId
            ? 'Playing from your PC. '
            : 'Model output for your review. '}
          Use <span className="text-zinc-400">Expand</span> for the full Browser view.
        </p>
      </div>
    </div>
  )
}
