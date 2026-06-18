import { useCallback, useEffect, useState } from 'react'
import type { ModelConfig, ModelInfo } from '@omega/sdk'
import { ModelLoadProgressBar } from './ModelLoadProgressBar'
import { ModelSettingsPanel } from './ModelSettingsPanel'
import { modelIdsMatch } from '../lib/model-id'
import { engineClient, refreshRuntimeSnapshot, useModelLoad } from '../lib/engine'

function formatBytes(n: number): string {
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** On-disk models (GGUF, HF folders, safetensors, ONNX, …). */
function localModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => !m.remote && Boolean(m.path))
}

function formatBadge(m: ModelInfo): string {
  return (m.format ?? m.metadata.formatLabel ?? 'model').toUpperCase()
}

export function InstalledModelsTab({
  models,
  defaultModel,
  modelsDir,
  onRefresh,
  onBrowseHub
}: {
  models: ModelInfo[]
  defaultModel: string
  modelsDir: string
  onRefresh: () => void
  onBrowseHub: () => void
}) {
  const installed = localModels(models)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeModel, setActiveModel] = useState('')
  const [loaded, setLoaded] = useState<string[]>([])
  const [modelConfigs, setModelConfigs] = useState<Record<string, ModelConfig>>({})
  const {
    load: loadModel,
    unload: unloadModel,
    busy,
    percent: loadPercent,
    status,
    error
  } = useModelLoad({ onRefresh })

  const refreshRuntime = useCallback(async () => {
    const snap = await refreshRuntimeSnapshot()
    setActiveModel(snap.activeModel)
    setLoaded(snap.loadedModels)
  }, [])

  useEffect(() => {
    void refreshRuntime()
    const t = setInterval(() => void refreshRuntime(), 4000)
    return () => clearInterval(t)
  }, [refreshRuntime])

  useEffect(() => {
    void engineClient.modelConfig.list().then(setModelConfigs).catch(() => {})
  }, [installed.length, onRefresh])

  useEffect(() => {
    if (installed.length === 0) {
      setSelectedId(null)
      return
    }
    setSelectedId((cur) => {
      if (cur && installed.some((m) => m.id === cur)) return cur
      const pref =
        defaultModel && installed.some((m) => modelIdsMatch(m.id, defaultModel))
          ? installed.find((m) => modelIdsMatch(m.id, defaultModel))!.id
          : installed[0]!.id
      return pref
    })
  }, [installed, defaultModel])

  const selected = installed.find((m) => m.id === selectedId)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2 text-xs">
        <span className="text-zinc-400">
          Folder: <code className="text-zinc-300">{modelsDir}</code>
        </span>
        <span className="text-zinc-500">
          {installed.length} local model{installed.length === 1 ? '' : 's'}
          {activeModel && (
            <>
              {' '}
              · active: <strong className="text-emerald-400">{activeModel}</strong>
            </>
          )}
        </span>
      </div>

      {busy && !error && (
        <ModelLoadProgressBar active percent={loadPercent} label={status ?? 'Loading…'} />
      )}

      {(status || error) && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            error ? 'border-rose-800 bg-rose-950/50 text-rose-200' : 'border-zinc-700 bg-zinc-900/60 text-zinc-300'
          }`}
        >
          {error ?? status}
        </div>
      )}

      {installed.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <p className="text-zinc-400">No local models yet (GGUF, safetensors, HF folders, ONNX, …).</p>
          <button type="button" onClick={onBrowseHub} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm">
            Open Model Studio
          </button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <p className="border-b border-zinc-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Installed
            </p>
            <ul className="flex-1 overflow-y-auto p-2">
              {installed.map((m) => {
                const isSel = m.id === selectedId
                const inMem = loaded.some((lid) => modelIdsMatch(lid, m.id))
                const isDef = modelIdsMatch(m.id, defaultModel)
                return (
                  <li key={m.id} className="mb-1">
                    <div
                      className={`rounded-lg transition ${
                        isSel ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'hover:bg-zinc-800'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedId(m.id)}
                        className="w-full px-3 py-2 text-left text-sm"
                      >
                        <p className="truncate font-medium text-zinc-200">{m.id}</p>
                        <p className="mt-0.5 text-[10px] text-zinc-500">
                          {formatBytes(m.size_bytes)} · {formatBadge(m)}
                          {m.metadata.quantization ? ` · ${m.metadata.quantization}` : ''}
                          {m.inferenceBackend === 'ollama'
                            ? ' · Ollama'
                            : m.inferenceBackend === 'exl2'
                              ? ' · EXL2'
                              : m.inferenceBackend === 'onnx'
                                ? ' · ONNX'
                                : m.nativeSupported
                                  ? ' · native'
                                  : ''}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">
                            manual
                          </span>
                          {inMem && (
                            <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[9px] text-emerald-300">
                              loaded
                            </span>
                          )}
                          {isDef && (
                            <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[9px] text-indigo-200">
                              default
                            </span>
                          )}
                          {m.metadata?.supportsMtp && (
                            <span className="rounded bg-violet-900/50 px-1.5 py-0.5 text-[9px] text-violet-200">
                              MTP
                            </span>
                          )}
                        </div>
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </aside>

          <section className="min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
            {selectedId && selected ? (
              <ModelSettingsPanel
                key={selectedId}
                modelId={selectedId}
                supportsMtp={Boolean(selected.metadata?.supportsMtp)}
                embedded
                isLoaded={loaded.some((lid) => modelIdsMatch(lid, selectedId))}
                isDefault={modelIdsMatch(selectedId, defaultModel)}
                loadBusy={busy}
                onLoad={() => void loadModel(selectedId, { style: 'installed' })}
                onUnload={() => void unloadModel(selectedId)}
                onSaved={() => {
                  void refreshRuntime()
                  void engineClient.modelConfig.list().then(setModelConfigs).catch(() => {})
                  onRefresh()
                }}
              />
            ) : (
              <p className="p-8 text-sm text-zinc-500">Select a model to configure parameters.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
