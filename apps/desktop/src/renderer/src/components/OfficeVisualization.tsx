import { useCallback, useEffect, useRef, useState } from 'react'
import type { OfficeVisualizationStatus } from '@omega/sdk'
import { engineClient } from '../lib/engine'

/**
 * Omega 3D office view (bundled office engine). Start/stop only affects visualization —
 * agent, MoA, and workforce tasks keep running in the background.
 */
export function OfficeVisualization({
  compact = false,
  autoStart = false
}: {
  /** Hide long description when embedded in OfficePage header */
  compact?: boolean
  /** Start office + gateway when the component mounts (Office page). */
  autoStart?: boolean
}) {
  const [st, setSt] = useState<OfficeVisualizationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('')
  const [viewReady, setViewReady] = useState(false)
  const [viewError, setViewError] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const webviewRef = useRef<HTMLElement>(null)
  const autoStarted = useRef(false)

  const reload = useCallback(async () => {
    setSt(await engineClient.office.visualizationStatus())
  }, [])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), 3000)
    return () => clearInterval(t)
  }, [reload])

  const gatewayOk = Boolean(st?.gatewayReady)
  const officeHttpOk = Boolean(st?.officeReady)
  const processStuck = Boolean(st?.running && !officeHttpOk)
  const showView = Boolean(officeHttpOk && st?.installed)
  const statusError = st?.error?.trim() ?? ''
  const officeSrc = st?.officeUrl
    ? `${st.officeUrl.replace(/\/$/, '')}/office?omega_embed=1`
    : ''

  useEffect(() => {
    setViewReady(false)
    setViewError('')
  }, [officeSrc])

  useEffect(() => {
    if (!showView || !officeSrc) return

    const onReady = () => {
      setViewReady(true)
      setViewError('')
      try {
        const w = iframeRef.current?.contentWindow
        w?.localStorage.setItem('claw3d:onboarding:completed', 'true')
        w?.localStorage.setItem('omega:office:onboarding', 'done')
      } catch {
        /* iframe / webview only */
      }
    }

    const iframe = iframeRef.current
    if (iframe) {
      iframe.addEventListener('load', onReady)
      return () => iframe.removeEventListener('load', onReady)
    }

    const wv = webviewRef.current as unknown as {
      addEventListener?: (type: string, listener: EventListener) => void
      removeEventListener?: (type: string, listener: EventListener) => void
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    if (!wv?.addEventListener) return

    const onWebviewLoad: EventListener = () => {
      onReady()
      wv.executeJavaScript?.(
        `try { localStorage.setItem("claw3d:onboarding:completed", "true"); localStorage.setItem("omega:office:onboarding", "done"); } catch(e) {}`
      ).catch(() => {})
    }
    const onWebviewFail: EventListener = (evt) => {
      const e = evt as Event & { errorDescription?: string; errorCode?: number }
      if (e?.errorCode === -3) return
      setViewReady(false)
      setViewError(
        e?.errorDescription ||
          'Failed to load the office page. The server may still be starting — try Refresh.'
      )
    }
    wv.addEventListener('did-finish-load', onWebviewLoad)
    wv.addEventListener('did-fail-load', onWebviewFail)
    return () => {
      wv.removeEventListener?.('did-finish-load', onWebviewLoad)
      wv.removeEventListener?.('did-fail-load', onWebviewFail)
    }
  }, [showView, officeSrc])

  const startView = async () => {
    setBusy(true)
    setLog('Starting office view…')
    try {
      if (!st?.installed) {
        const setup = await engineClient.office.visualizationSetup()
        if (!setup.ok) {
          setLog(setup.error ?? 'Setup failed')
          return
        }
      }
      const r = await engineClient.office.startVisualization()
      if (!r.success) {
        setLog(r.error ?? 'Failed to start')
        autoStarted.current = false
      } else if (!r.officeReady) setLog('Starting… keep this page open.')
      else if (r.gatewayReady === false)
        setLog('Office server is up; gateway adapter still starting…')
      else setLog('')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!autoStart || autoStarted.current || busy) return
    if (officeHttpOk) return
    autoStarted.current = true
    void startView()
  }, [autoStart, officeHttpOk, busy])

  const stopView = async () => {
    setBusy(true)
    try {
      await engineClient.office.stopVisualization()
      setLog('Office view stopped. Agents and tasks are still running.')
      setViewReady(false)
      setViewError('')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const refreshView = () => {
    setViewError('')
    setViewReady(false)
    const wv = webviewRef.current as unknown as { reload?: () => void } | null
    if (wv?.reload) {
      wv.reload()
      return
    }
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.location.reload()
    }
  }

  if (!st) {
    return <p className="text-sm text-zinc-500">Loading office…</p>
  }

  const useWebview = typeof customElements !== 'undefined' && !!customElements.get('webview')

  return (
    <div className={`flex h-full min-h-[320px] flex-col ${compact ? 'gap-2' : 'gap-3'} text-sm`}>
      {!compact && (
        <p className="text-zinc-400">
          3D office shows your workforce moving between desks, monitors, and meeting areas. Stopping
          the view does not stop agent work — only the animation.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!officeHttpOk && !processStuck ? (
          <button
            type="button"
            disabled={busy || !st.installed}
            className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            onClick={() => void startView()}
          >
            {busy ? 'Starting…' : 'Start office view'}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
              onClick={() => void stopView()}
            >
              Stop office view
            </button>
            {showView && (
              <button
                type="button"
                disabled={busy}
                className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
                onClick={refreshView}
              >
                Refresh
              </button>
            )}
          </>
        )}
        {showView && (
          <a
            href={officeSrc}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-indigo-300 hover:bg-zinc-800"
          >
            Open in browser
          </a>
        )}
        <span className="text-[10px] text-zinc-500">
          {showView && viewReady
            ? 'Live'
            : processStuck
              ? 'Starting (stuck)'
              : officeHttpOk
                ? 'Running'
                : 'Stopped'}
          {st?.running && officeHttpOk && !gatewayOk && ' · gateway connecting…'}
          {st?.running && gatewayOk && ' · gateway ok'}
          {!st?.installed && ' · bundle missing'}
        </span>
      </div>

      {(statusError || st?.error) && (
        <p className="text-xs text-red-300/90" role="alert">
          {statusError || st?.error}
        </p>
      )}
      {log && (
        <p
          className={`text-xs ${log.toLowerCase().includes('failed') || log.toLowerCase().includes('error') || log.includes('EADDRINUSE') || log.includes('not found') ? 'text-red-300/90' : 'text-amber-300/90'}`}
          role={log.toLowerCase().includes('failed') ? 'alert' : undefined}
        >
          {log}
        </p>
      )}

      {showView ? (
        <div className="relative min-h-0 flex-1">
          {(!viewReady || viewError) && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded border border-zinc-800 bg-zinc-950 p-6 text-center text-xs">
              {viewError ? (
                <>
                  <p className="font-medium text-amber-200">Could not load office</p>
                  <p className="max-w-md text-zinc-500">{viewError}</p>
                  <button
                    type="button"
                    className="rounded bg-indigo-600 px-3 py-1.5 text-white"
                    onClick={refreshView}
                  >
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <p className="text-zinc-400">Loading 3D office…</p>
                  {!gatewayOk && (
                    <p className="max-w-sm text-[11px] text-zinc-500">
                      Gateway adapter on port 18789 is still starting. The floor may appear once it
                      connects.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {!gatewayOk && viewReady && (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 rounded bg-amber-950/80 px-2 py-1 text-center text-[10px] text-amber-200">
              Gateway not ready — avatars may be idle until port 18789 is up
            </div>
          )}
          {useWebview ? (
            <webview
              ref={webviewRef as React.RefObject<HTMLElement>}
              src={officeSrc}
              style={{ width: '100%', height: '100%', minHeight: 280, border: 'none' }}
              // @ts-expect-error Electron webview attribute
              allowpopups="true"
            />
          ) : (
            <iframe
              ref={iframeRef}
              title="Omega Office"
              src={officeSrc}
              className="h-full min-h-[280px] w-full rounded border border-zinc-800 bg-zinc-950"
              allow="fullscreen"
              referrerPolicy="no-referrer-when-downgrade"
              onError={() =>
                setViewError('Iframe failed to load. Rebuild Omega after updating claw3d-office.')
              }
            />
          )}
        </div>
      ) : processStuck ? (
        <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-amber-800/50 bg-zinc-950/50 p-8 text-center text-xs text-amber-200/90">
          <p>{statusError ? 'Office server failed to start' : 'Office server is starting…'}</p>
          {statusError ? (
            <p className="max-w-md text-[11px] text-red-300/90">{statusError}</p>
          ) : (
            <p className="max-w-sm text-[11px] text-zinc-500">
              If this stays blank, check %USERPROFILE%\.omega\logs\office-view.log
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-zinc-800 bg-zinc-950/50 p-8 text-center text-xs text-zinc-500">
          <p>Office view is off.</p>
          <p className="max-w-sm text-[11px] text-zinc-600">
            Start the view — Omega starts the office server and gateway automatically (same flow as
            Hermes desktop).
          </p>
        </div>
      )}
    </div>
  )
}
