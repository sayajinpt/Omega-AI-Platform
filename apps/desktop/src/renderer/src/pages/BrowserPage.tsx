import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserStatus } from '@omega/sdk'
import { normalizeBrowserUrl } from '../../../shared/browser-open'
import { engineClient } from '../lib/engine'
import { domRectToShellBounds } from '../lib/browser-bounds'
import { boundsFromElement, placeEmbeddedBrowser, scheduleBoundsSettle } from '../lib/browser-placement'

const HOME = 'https://duckduckgo.com/'

export function BrowserPage({
  active = true,
  pendingUrl = null,
  onPendingUrlConsumed
}: {
  active?: boolean
  pendingUrl?: string | null
  onPendingUrlConsumed?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const placementFailedRef = useRef(false)
  const [urlInput, setUrlInput] = useState(HOME)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [stealth, setStealth] = useState<{ available: boolean; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [placementError, setPlacementError] = useState<string | null>(null)

  const syncBounds = useCallback(() => {
    if (!active) return
    const el = hostRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return
    void engineClient.browser.setBounds(domRectToShellBounds(r))
  }, [active])

  const navigate = useCallback(
    async (raw: string): Promise<void> => {
      setError(null)
      const target = normalizeBrowserUrl(raw)
      if (!target) return
      try {
        const el = hostRef.current
        if (el && active) {
          const placed = await placeEmbeddedBrowser(el, target, 'full', 320, 240)
          if (!placed) {
            placementFailedRef.current = true
            setPlacementError('Could not position the embedded browser. Resize the window or switch tabs and back.')
          } else {
            placementFailedRef.current = false
            setPlacementError(null)
          }
        } else {
          await engineClient.browser.navigate(target)
        }
        const st = await engineClient.browser.getStatus()
        if (st) {
          setStatus(st)
          setUrlInput(st.url || target)
        } else {
          setUrlInput(target)
        }
        if (st && (st as { embeddedAvailable?: boolean }).embeddedAvailable === false) {
          setError(
            'Embedded browser unavailable — restart Omega or rebuild with build.bat if this persists.'
          )
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [active]
  )

  useEffect(() => {
    void engineClient.browser.info().then(setStealth)
    const off = engineClient.browser.onStatus(setStatus)
    return () => off()
  }, [])

  useEffect(() => {
    if (!pendingUrl?.trim()) return
    void navigate(pendingUrl).finally(() => onPendingUrlConsumed?.())
  }, [pendingUrl, navigate, onPendingUrlConsumed])

  useEffect(() => {
    if (!active) {
      void engineClient.browser.hide()
      return
    }

    const el = hostRef.current
    if (!el) return
    let cancelled = false
    const settleTimers: number[] = []

    const runPlacement = async (): Promise<void> => {
      setPlacementError(null)
      placementFailedRef.current = false
      const placed = await placeEmbeddedBrowser(el, HOME, 'full', 320, 240)
      if (cancelled) return
      if (!placed) {
        placementFailedRef.current = true
        setPlacementError('Could not position the embedded browser. Resize the window or switch tabs and back.')
        return
      }
      settleTimers.push(
        ...scheduleBoundsSettle(
          () => boundsFromElement(el, 320, 240),
          () => cancelled
        )
      )
      window.setTimeout(() => {
        if (cancelled) return
        void engineClient.browser.getStatus().then((s) => {
          if (s) setStatus(s)
          if (!s?.url || s.url === 'about:blank') void navigate(HOME)
        })
      }, 600)
    }

    void runPlacement()

    const ro = new ResizeObserver(() => {
      syncBounds()
      if (!cancelled && placementFailedRef.current) void runPlacement()
    })
    ro.observe(el)
    window.addEventListener('resize', syncBounds)

    return () => {
      cancelled = true
      for (const t of settleTimers) window.clearTimeout(t)
      ro.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [active, syncBounds, navigate])

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <header className="shrink-0 space-y-2 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-indigo-300">Browser</h2>
          <span className="text-[10px] text-zinc-500">
            {stealth?.available ? (
              <span className="text-emerald-400">Stealth fetch ready</span>
            ) : (
              <span title={stealth?.error}>Built-in Chromium · install playwright-core for stealth fetch</span>
            )}
          </span>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void navigate(urlInput)
          }}
        >
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              disabled={!status?.canGoBack}
              onClick={() => void engineClient.browser.back().then((s) => s && setStatus(s))}
              className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs disabled:opacity-30"
              title="Back"
            >
              ←
            </button>
            <button
              type="button"
              disabled={!status?.canGoForward}
              onClick={() => void engineClient.browser.forward().then((s) => s && setStatus(s))}
              className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs disabled:opacity-30"
              title="Forward"
            >
              →
            </button>
            <button
              type="button"
              onClick={() => void engineClient.browser.reload().then((s) => s && setStatus(s))}
              className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs"
              title="Reload"
            >
              ↻
            </button>
          </div>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500"
          >
            Go
          </button>
        </form>
        {status && (
          <p className="truncate text-[10px] text-zinc-500">
            {status.loading ? 'Loading…' : status.title || status.url}
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-rose-800 bg-rose-950/40 px-2 py-1 text-xs text-rose-200">
            {error}
          </p>
        )}
        {placementError && (
          <p className="rounded-lg border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
            {placementError}
          </p>
        )}
        <p className="text-[10px] text-zinc-600">
          Models can use <code className="text-zinc-400">browser_navigate</code>,{' '}
          <code className="text-zinc-400">browser_snapshot</code>, and{' '}
          <code className="text-zinc-400">browser_stealth_fetch</code> (headless Chromium) in agent mode.
        </p>
      </header>

      <div
        ref={hostRef}
        className="min-h-0 flex-1 bg-transparent"
        aria-label="Embedded browser viewport"
      />
    </div>
  )
}
