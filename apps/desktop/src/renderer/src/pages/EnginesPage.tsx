import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { engineClient } from '../lib/engine'

interface EngineStatus {
  omegaEngine: {
    name: string
    kind: string
    present: boolean
    available: boolean
    state?: string
    error?: string
    inferAvailable?: boolean
  }
  ollama: {
    name: string
    kind: string
    available: boolean
    running: boolean
    port?: number
    pid?: number
    version?: string
    error?: string
  }
}

interface OllamaModel {
  name: string
  size: number
}

interface PullProgress {
  name: string
  status: string
  completed?: number
  total?: number
}

export function EnginesPage(): ReactElement {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [models, setModels] = useState<OllamaModel[]>([])
  const [pullName, setPullName] = useState('')
  const [progress, setProgress] = useState<PullProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await engineClient.engines.status()
      setStatus(s)
      if (s.ollama.running) {
        const ms = await engineClient.engines.listOllama().catch(() => [])
        setModels(ms)
      } else {
        setModels([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const i = setInterval(() => void refresh(), 3000)
    const unsub = engineClient.engines.onPullProgress((p) => setProgress(p))
    return () => {
      clearInterval(i)
      unsub()
    }
  }, [refresh])

  const start = async (): Promise<void> => {
    setBusy('start')
    setError(null)
    try {
      await engineClient.engines.startOllama()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const stop = async (): Promise<void> => {
    setBusy('stop')
    try {
      await engineClient.engines.stopOllama()
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  const pull = async (): Promise<void> => {
    if (!pullName.trim()) return
    setBusy('pull')
    setError(null)
    setProgress({ name: pullName, status: 'starting' })
    try {
      await engineClient.engines.pullOllama(pullName.trim())
      setProgress({ name: pullName, status: 'done' })
      setPullName('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const engine = status?.omegaEngine

  return (
    <section className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h2 className="text-lg font-semibold">Inference engines</h2>
        <p className="text-sm text-zinc-500">
          Omega ships bundled GGUF (omega-engine), optional sidecar formats, and Ollama — all loopback-local.
        </p>
      </header>
      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded border border-rose-700 bg-rose-950/50 p-3 text-xs text-rose-200">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <article className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-base font-semibold text-emerald-300">omega-engine</h3>
              <span
                className={`rounded px-2 py-0.5 text-[10px] ${
                  !engine?.present
                    ? 'bg-rose-900/50 text-rose-200'
                    : engine.available
                      ? 'bg-emerald-900/50 text-emerald-200'
                      : 'bg-amber-900/50 text-amber-200'
                }`}
              >
                {!engine?.present
                  ? 'missing from install'
                  : engine.available
                    ? 'ready'
                    : engine.state ?? 'starting'}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-400">
              Primary GGUF engine (libomega_infer). Handles chat, embeddings, vision (mtmd), and
              speculative decoding (MTP) via bundled omega-infer.
            </p>
            {engine?.error && (
              <p className="mt-2 rounded bg-rose-950/40 p-2 text-[10px] text-rose-200">{engine.error}</p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <dt className="text-zinc-500">Infer subprocess</dt>
              <dd className="font-mono">{engine?.inferAvailable ? 'available' : '—'}</dd>
            </dl>
          </article>

          <article className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-base font-semibold text-sky-300">omega-ollama (bundled)</h3>
              <span
                className={`rounded px-2 py-0.5 text-[10px] ${
                  !status?.ollama.available
                    ? 'bg-zinc-800 text-zinc-500'
                    : status.ollama.running
                      ? 'bg-emerald-900/50 text-emerald-200'
                      : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {!status?.ollama.available
                  ? 'not installed'
                  : status.ollama.running
                    ? `running · 127.0.0.1:${status.ollama.port}`
                    : 'stopped'}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-400">
              Second engine for safetensors, AWQ, GPTQ, and Ollama-native models. Auto-spawned on a
              private loopback port.
            </p>
            {status?.ollama.error && (
              <p className="mt-2 rounded bg-rose-950/40 p-2 text-[10px] text-rose-200">
                {status.ollama.error}
              </p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <dt className="text-zinc-500">Version</dt>
              <dd className="font-mono">{status?.ollama.version ?? '—'}</dd>
              <dt className="text-zinc-500">PID</dt>
              <dd className="font-mono">{status?.ollama.pid ?? '—'}</dd>
            </dl>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={!status?.ollama.available || status.ollama.running || busy === 'start'}
                onClick={start}
                className="rounded bg-emerald-700 px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === 'start' ? 'Starting…' : 'Start'}
              </button>
              <button
                type="button"
                disabled={!status?.ollama.running || busy === 'stop'}
                onClick={stop}
                className="rounded bg-zinc-700 px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </div>
          </article>
        </div>

        <article className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-base font-semibold">Ollama library</h3>
            <span className="text-[10px] text-zinc-500">
              Pulls non-GGUF models on demand. They appear in the chat picker as{' '}
              <code>ollama:&lt;name&gt;</code>.
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              placeholder="qwen3:8b · llama3.3:70b · hf.co/owner/repo"
              className="flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm font-mono"
              disabled={!status?.ollama.running || busy === 'pull'}
            />
            <button
              type="button"
              onClick={pull}
              disabled={!status?.ollama.running || busy === 'pull' || !pullName.trim()}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'pull' ? 'Pulling…' : 'Pull'}
            </button>
          </div>
          {progress && (
            <div className="mt-2 text-[11px] text-zinc-400">
              <span className="font-mono">{progress.name}</span> · {progress.status}
              {progress.completed != null && progress.total != null && progress.total > 0 && (
                <span className="ml-2">
                  {((progress.completed / progress.total) * 100).toFixed(1)}%
                </span>
              )}
            </div>
          )}
          <ul className="mt-3 divide-y divide-zinc-800 rounded border border-zinc-800">
            {models.length === 0 && (
              <li className="px-3 py-2 text-xs text-zinc-500">
                {status?.ollama.running ? 'No models pulled yet.' : 'Start the engine to list models.'}
              </li>
            )}
            {models.map((m) => (
              <li key={m.name} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-mono">{m.name}</span>
                <span className="text-[11px] text-zinc-500">
                  {(m.size / 1024 ** 3).toFixed(2)} GB
                </span>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  )
}
