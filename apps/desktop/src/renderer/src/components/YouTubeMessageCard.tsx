import { useCallback, useEffect, useRef } from 'react'
import { engineClient } from '../lib/engine'
import {
  boundsFromElement,
  placeEmbeddedBrowser,
  scheduleBoundsSettle
} from '../lib/browser-placement'
import { requestOmegaBrowser } from '../lib/open-omega-browser'

const EMBED_HEIGHT = 280

function youtubeWatchUrl(embedUrl?: string, watchUrl?: string): string {
  const watch = watchUrl?.trim() ?? ''
  if (watch) return watch
  const embed = embedUrl?.trim() ?? ''
  if (!embed) return ''
  const m = embed.match(/\/embed\/([a-zA-Z0-9_-]{11})/)
  if (m?.[1]) return `https://www.youtube.com/watch?v=${m[1]}`
  return embed
}

/** Inline YouTube player — WebView2 host (iframes fail with "Video unavailable" in the desktop shell). */
export function YouTubeMessageCard({
  embedUrl,
  watchUrl,
  title
}: {
  embedUrl?: string
  watchUrl?: string
  title?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const navigateTarget = youtubeWatchUrl(embedUrl, watchUrl)

  const syncBounds = useCallback(() => {
    const el = hostRef.current
    if (!el) return
    const b = boundsFromElement(el, 280, 200)
    if (b) void engineClient.browser.setBounds(b)
  }, [])

  useEffect(() => {
    const el = hostRef.current
    if (!el || !navigateTarget) return
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
  }, [navigateTarget, syncBounds])

  const openBrowser = (): void => {
    if (navigateTarget) requestOmegaBrowser(navigateTarget)
  }

  if (!navigateTarget) return null

  return (
    <div className="my-2 w-full max-w-full">
      {title ? <p className="mb-1 truncate text-xs text-zinc-400">{title}</p> : null}
      <div
        ref={hostRef}
        className="w-full overflow-hidden rounded-lg bg-black ring-1 ring-zinc-700/60"
        style={{ height: EMBED_HEIGHT }}
        aria-label="YouTube player"
      />
      <button
        type="button"
        className="mt-1.5 text-[10px] text-indigo-300 hover:underline"
        onClick={openBrowser}
      >
        Open in Browser tab
      </button>
    </div>
  )
}
