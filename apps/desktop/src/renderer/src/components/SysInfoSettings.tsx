import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { engineClient } from '../lib/engine'

type BackendRow = {
  id: string
  label: string
  compiled: boolean
  available: boolean
}

type GpuRow = {
  kind: string
  index: number
  name: string
  memory_mb?: number
  driver_version?: string
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ok ? 'bg-emerald-900/50 text-emerald-300' : 'bg-zinc-800 text-zinc-500'
      }`}
    >
      {label}
    </span>
  )
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <h4 className="text-sm font-semibold text-zinc-300">{title}</h4>
      {children}
    </section>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/60 py-1.5 text-sm last:border-0">
      <span className="text-zinc-500">{label}</span>
      <span className="max-w-[65%] break-all text-right text-zinc-200">{value}</span>
    </div>
  )
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function str(v: unknown, fallback = '—'): string {
  if (typeof v === 'string' && v.length) return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fallback
}

function bool(v: unknown): boolean {
  return v === true
}

function csAccelLabel(media: Record<string, unknown> | null, kind: 'image' | 'tts' | 'video'): string {
  const gen = asRecord(media?.contentStudioGeneration)
  const acc = asRecord(gen?.accelerators)
  const row = asRecord(acc?.[kind])
  if (row && typeof row.label === 'string' && row.label.length) return row.label
  const fallback =
    kind === 'image'
      ? media?.imageAccelerator
      : kind === 'tts'
        ? media?.ttsAccelerator
        : media?.videoAccelerator
  if (fallback === 'cuda') return 'CUDA'
  if (fallback === 'directml') return 'DirectML (AMD/Intel GPU)'
  if (fallback === 'cpu') return 'CPU'
  return str(fallback, '—')
}

export function SysInfoSettings() {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setInfo(await engineClient.system.info())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setInfo(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 15000)
    return () => window.clearInterval(id)
  }, [refresh])

  if (loading && !info) {
    return <p className="text-sm text-zinc-500">Loading system information…</p>
  }

  if (error && !info) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-red-400">{error}</p>
        <button type="button" onClick={() => void refresh()} className="rounded bg-zinc-800 px-3 py-1.5 text-xs">
          Retry
        </button>
      </div>
    )
  }

  if (!info) return null

  const host = asRecord(info.host)
  const app = asRecord(info.app)
  const runtime = asRecord(info.runtime)
  const runtimeStatus = asRecord(info.runtimeStatus)
  const inference = asRecord(info.inference)
  const omegaEngine = asRecord(info.omegaEngine)
  const engineHealth = asRecord(omegaEngine?.health)
  const ollama = asRecord(info.ollama)
  const python = asRecord(info.python)
  const contentStudio = asRecord(info.contentStudio)
  const sidecar = asRecord(info.sidecar)
  const media = asRecord(info.mediaCapabilities)
  const modelLoad = asRecord(info.modelLoadProgress)
  const routerModels = asRecord(info.routerModels)
  const officeViz = asRecord(info.officeVisualization)

  const backends = asArray<BackendRow>(inference?.backends)
  const gpus = asArray<GpuRow>(info.gpuDevices)
  const loadedModels = asArray<string>(runtimeStatus?.loadedModels)

  const collectedAt = typeof info.collectedAt === 'number' ? new Date(info.collectedAt).toLocaleString() : '—'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">Last updated {collectedAt} · refreshes every 15s</p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      <InfoSection title="Host">
        <InfoRow label="OS" value={str(host?.os, str(host?.platform))} />
        <InfoRow label="Architecture" value={str(host?.arch)} />
        <InfoRow label="Hostname" value={str(host?.hostname)} />
        <InfoRow label="CPUs" value={str(host?.cpus)} />
        <InfoRow
          label="Memory"
          value={
            host?.totalMemoryMb != null
              ? `${str(host.freeMemoryMb)} MB free / ${str(host.totalMemoryMb)} MB total`
              : '—'
          }
        />
        <InfoRow label="Omega home" value={str(info.omegaHome)} />
      </InfoSection>

      <InfoSection title="Application">
        <InfoRow label="Version" value={str(app?.currentVersion)} />
        <InfoRow label="Packaged install" value={bool(app?.packaged) ? 'Yes' : 'No'} />
        <InfoRow label="Runtime" value={str(runtime?.name)} />
        <InfoRow label="Runtime version" value={str(runtime?.version)} />
        <InfoRow label="HTTP port" value={str(runtime?.default_port)} />
      </InfoSection>

      <InfoSection title="Inference backend">
        <InfoRow
          label="Active backend"
          value={
            <span className="font-medium text-indigo-300">{str(inference?.primary, 'cpu').toUpperCase()}</span>
          }
        />
        <InfoRow label="GPU offload" value={bool(inference?.gpuOffload) ? 'Enabled' : 'Disabled'} />
        <InfoRow label="Compiled into engine" value={str(inference?.compiled)} />
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-left text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="pb-2 pr-3 font-medium">Backend</th>
                <th className="pb-2 pr-3 font-medium">Built in</th>
                <th className="pb-2 font-medium">Available</th>
              </tr>
            </thead>
            <tbody>
              {backends.map((b) => (
                <tr key={b.id} className="border-t border-zinc-800/60">
                  <td className="py-1.5 pr-3 text-zinc-300">{b.label}</td>
                  <td className="py-1.5 pr-3">
                    <StatusPill ok={b.compiled} label={b.compiled ? 'yes' : 'no'} />
                  </td>
                  <td className="py-1.5">
                    <StatusPill ok={b.available} label={b.available ? 'yes' : 'no'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </InfoSection>

      <InfoSection title="GPU devices">
        {gpus.length === 0 ? (
          <p className="text-sm text-zinc-500">No GPU devices detected.</p>
        ) : (
          gpus.map((g) => (
            <div key={`${g.kind}-${g.index}`} className="rounded border border-zinc-800/80 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-200">{g.name}</span>
                <StatusPill ok label={g.kind.toUpperCase()} />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {g.memory_mb != null ? `${g.memory_mb} MB` : '—'}
                {g.driver_version ? ` · driver ${g.driver_version}` : ''}
              </p>
            </div>
          ))
        )}
      </InfoSection>

      <InfoSection title="omega-engine">
        <InfoRow
          label="Process"
          value={<StatusPill ok={bool(omegaEngine?.present)} label={bool(omegaEngine?.present) ? 'running' : 'offline'} />}
        />
        {omegaEngine?.lastError ? (
          <InfoRow label="Last error" value={<span className="text-amber-400">{str(omegaEngine.lastError)}</span>} />
        ) : null}
        <InfoRow label="Engine version" value={str(engineHealth?.version)} />
        <InfoRow label="Infer library" value={bool(engineHealth?.infer_available) ? 'linked' : 'missing'} />
        <InfoRow label="Queue depth" value={str(engineHealth?.inference_queue_depth)} />
        <InfoRow label="Busy" value={bool(engineHealth?.inference_busy) ? 'yes' : 'no'} />
        <InfoRow label="Vision" value={bool(engineHealth?.vision) ? 'yes' : 'no'} />
        <InfoRow label="Layer paging" value={bool(engineHealth?.paging) ? 'yes' : 'no'} />
      </InfoSection>

      <InfoSection title="Models & runtime">
        <InfoRow
          label="State"
          value={<StatusPill ok={str(runtimeStatus?.state) === 'ready'} label={str(runtimeStatus?.state, 'unknown')} />}
        />
        <InfoRow label="Active model" value={str(runtimeStatus?.activeModel, 'none')} />
        <InfoRow label="Loaded models" value={loadedModels.length ? loadedModels.join(', ') : 'none'} />
        <InfoRow
          label="Load progress"
          value={
            modelLoad?.phase
              ? `${str(modelLoad.phase)} (${str(modelLoad.percent)}%)`
              : 'idle'
          }
        />
      </InfoSection>

      <InfoSection title="Services">
        <InfoRow
          label="Ollama"
          value={
            <StatusPill
              ok={bool(ollama?.running)}
              label={bool(ollama?.running) ? `running :${str(ollama?.port, '11434')}` : str(ollama?.error, 'stopped')}
            />
          }
        />
        <InfoRow
          label="Python venv"
          value={
            <StatusPill
              ok={bool(python?.venv_present)}
              label={bool(python?.venv_present) ? str(python?.python_path) : 'not set up'}
            />
          }
        />
        <InfoRow
          label="Content Studio"
          value={
            <StatusPill
              ok={bool(contentStudio?.ready)}
              label={
                bool(contentStudio?.ready)
                  ? str(contentStudio?.mode, 'ready')
                  : str(contentStudio?.error, 'not ready')
              }
            />
          }
        />
        <InfoRow
          label="Sidecar EXL2"
          value={
            <StatusPill
              ok={bool(sidecar?.exl2ImportOk)}
              label={bool(sidecar?.exl2Installed) ? (bool(sidecar?.exl2ImportOk) ? 'import ok' : 'import failed') : 'not installed'}
            />
          }
        />
        <InfoRow
          label="Sidecar ONNX"
          value={
            <StatusPill
              ok={bool(sidecar?.onnxImportOk)}
              label={bool(sidecar?.onnxInstalled) ? (bool(sidecar?.onnxImportOk) ? 'import ok' : 'import failed') : 'not installed'}
            />
          }
        />
        <InfoRow label="Router models" value={str(routerModels?.status, str(routerModels?.phase, '—'))} />
        <InfoRow label="Office 3D viz" value={str(officeViz?.state, str(officeViz?.status, '—'))} />
      </InfoSection>

      <InfoSection title="Media capabilities">
        <p className="text-[11px] text-zinc-500">
          Chat vision uses the loaded GGUF. Image, TTS, and video use Content Studio generation models
          (download under Model Studio) plus the Python venv above.
        </p>
        <InfoRow label="Image generation" value={bool(media?.imageGenerate) ? 'yes' : 'no'} />
        <InfoRow label="TTS" value={bool(media?.ttsGenerate) ? 'yes' : 'no'} />
        <InfoRow label="Text-to-video" value={bool(media?.videoGenerate) ? 'yes' : 'no'} />
        <InfoRow label="Vision (chat)" value={bool(media?.vision) ? 'yes' : 'no'} />
        <InfoRow label="Image backend" value={str(media?.imageBackend, '—')} />
        <InfoRow label="TTS backend" value={str(media?.ttsBackend, '—')} />
        <InfoRow label="Video backend" value={str(media?.videoBackend, '—')} />
        {asRecord(media?.contentStudioGeneration) && (
          <>
            <InfoRow label="PyTorch image accelerator" value={csAccelLabel(media, 'image')} />
            <InfoRow label="PyTorch TTS accelerator" value={csAccelLabel(media, 'tts')} />
            <InfoRow label="PyTorch video accelerator" value={csAccelLabel(media, 'video')} />
            <InfoRow
              label="Generation models on disk"
              value={`TTS ${str(asRecord(media?.contentStudioGeneration)?.installedTtsCount, '0')} · image ${str(asRecord(media?.contentStudioGeneration)?.installedImageCount, '0')} · video ${str(asRecord(media?.contentStudioGeneration)?.installedVideoCount, '0')}`}
            />
            {!bool(asRecord(media?.contentStudioGeneration)?.pythonReady) && (
              <p className="text-[11px] text-amber-300/90">
                Python venv not ready — run setup if generation models are missing after download.
              </p>
            )}
            {bool(asRecord(media?.contentStudioGeneration)?.pythonReady) &&
              !bool(media?.imageGenerate) &&
              !bool(media?.ttsGenerate) &&
              !bool(media?.videoGenerate) && (
                <p className="text-[11px] text-amber-300/90">
                  No generation models installed yet — use Model Studio → Browse HF or Settings → Model
                  roles suggested downloads.
                </p>
              )}
          </>
        )}
      </InfoSection>
    </div>
  )
}
