import { useEffect, useState } from 'react'
import type { DebugEvent } from '@omega/sdk'
import { engineClient } from '../lib/engine'
import { probeNativeRuntime, type NativeRuntimeProbe } from '../lib/runtime-transport'

export function DebugPage({
  log,
  runtimeState
}: {
  log: string[]
  runtimeState: string
}) {
  const [events, setEvents] = useState<DebugEvent[]>([])
  const [tab, setTab] = useState<'events' | 'legacy'>('events')
  const [loaded, setLoaded] = useState<string[]>([])
  const [runtimeDiag, setRuntimeDiag] = useState<{
    activeModel?: string
    nativeLoaded?: string
    routedModel?: string
    runtimeLoadedStems?: string[]
    resolvedCatalogIds?: string[]
  } | null>(null)
  const [nativeRuntime, setNativeRuntime] = useState<NativeRuntimeProbe | null>(null)

  useEffect(() => {
    engineClient.debug.history().then(setEvents)
    const off = engineClient.debug.onEvent((e) => setEvents((prev) => [e, ...prev].slice(0, 2000)))
    engineClient.runtime.loadedModels().then(setLoaded).catch(() => [])
    engineClient.runtime.status().then(setRuntimeDiag).catch(() => null)
    void probeNativeRuntime().then(setNativeRuntime)
    const offRuntime = engineClient.runtime.onStatusChanged((s) => {
      setRuntimeDiag(s)
    })
    return () => {
      off()
      offRuntime()
    }
  }, [])

  const tokens = events.filter((e) => e.level === 'token')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">Debug Console</h2>
          <p className="text-sm text-zinc-500">Runtime: {runtimeState} · Loaded: {loaded.join(', ') || 'none'}</p>
          <p className="mt-1 text-[11px] text-zinc-600">
            selected={runtimeDiag?.routedModel || 'none'} · native={runtimeDiag?.nativeLoaded || 'none'} · runtimeStems=
            {runtimeDiag?.runtimeLoadedStems?.join(', ') || 'none'} · catalog=
            {runtimeDiag?.resolvedCatalogIds?.join(', ') || 'none'}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            Omega runtime:{' '}
            {nativeRuntime?.reachable
              ? `${nativeRuntime.info?.version ?? 'ok'} · build ${(nativeRuntime.info as { build_tag?: string })?.build_tag ?? 'unknown'} @ ${nativeRuntime.baseUrl}`
              : nativeRuntime
                ? `offline (${nativeRuntime.error ?? 'not running'})`
                : 'checking…'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('events')}
            className={`rounded px-3 py-1 text-sm ${tab === 'events' ? 'bg-indigo-600' : 'bg-zinc-800'}`}
          >
            Events
          </button>
          <button
            type="button"
            onClick={() => setTab('legacy')}
            className={`rounded px-3 py-1 text-sm ${tab === 'legacy' ? 'bg-indigo-600' : 'bg-zinc-800'}`}
          >
            Log
          </button>
        </div>
      </header>
      {tab === 'events' ? (
        <div className="grid flex-1 grid-cols-2 overflow-hidden">
          <pre className="overflow-y-auto border-r border-zinc-800 p-4 font-mono text-xs text-zinc-400">
            {events.length === 0
              ? 'No events.'
              : events.map((e) => (
                  <div key={e.ts + e.message} className="mb-1">
                    <span className="text-zinc-600">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
                    <span
                      className={
                        e.level === 'error' ? 'text-red-400' : e.level === 'token' ? 'text-cyan-400' : 'text-zinc-300'
                      }
                    >
                      [{e.source}] {e.message}
                    </span>
                  </div>
                ))}
          </pre>
          <pre className="overflow-y-auto p-4 font-mono text-xs text-cyan-300/80">
            {tokens.length === 0 ? 'Token stream…' : tokens.map((e) => e.message).join('')}
          </pre>
        </div>
      ) : (
        <pre className="flex-1 overflow-y-auto p-6 font-mono text-xs text-zinc-400">
          {log.length === 0 ? 'No log lines.' : log.join('\n')}
        </pre>
      )}
    </div>
  )
}
