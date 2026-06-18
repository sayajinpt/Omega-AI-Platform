import { engineClient } from '../../lib/engine'
import { useCallback, useEffect, useState } from 'react'
import type {
  FinetuneDatasetEntry,
  FinetuneDatasetPreset,
  FinetuneModality,
  FinetuneSourceInspect
} from '@omega/sdk'

function formatBytes(n?: number): string {
  if (n == null) return '—'
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function FinetuneDatasetManager({
  modality,
  sources: sourcesIn,
  onSourcesChange,
  onPreview,
  preview,
  busy
}: {
  modality: FinetuneModality
  sources: string[]
  onSourcesChange: (paths: string[]) => void
  onPreview: () => void
  preview: string
  busy: boolean
}) {
  const sources = Array.isArray(sourcesIn) ? sourcesIn : []
  const [prepared, setPrepared] = useState<FinetuneDatasetEntry[]>([])
  const [presets, setPresets] = useState<FinetuneDatasetPreset[]>([])
  const [inspects, setInspects] = useState<Record<string, FinetuneSourceInspect>>({})
  const [root, setRoot] = useState('')
  const [presetName, setPresetName] = useState('')
  const [manualPath, setManualPath] = useState('')

  const reload = useCallback(async () => {
    try {
      const [datasets, presetRows, datasetsRoot] = await Promise.all([
        engineClient.finetune.listDatasets(),
        engineClient.finetune.listPresets(),
        engineClient.finetune.datasetsRoot()
      ])
      setPrepared(Array.isArray(datasets) ? datasets : [])
      setPresets(Array.isArray(presetRows) ? presetRows : [])
      setRoot(typeof datasetsRoot === 'string' ? datasetsRoot : '')
    } catch {
      setPrepared([])
      setPresets([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const next: Record<string, FinetuneSourceInspect> = {}
      for (const p of sources) {
        next[p] = await engineClient.finetune.inspectSource(p)
      }
      if (!cancelled) setInspects(next)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [sources])

  const addPaths = (paths: string[] | unknown) => {
    const incoming = Array.isArray(paths) ? paths : []
    const merged = [...sources]
    for (const p of incoming) {
      if (typeof p === 'string' && p && !merged.includes(p)) merged.push(p)
    }
    onSourcesChange(merged)
  }

  const removePath = (path: string) => onSourcesChange(sources.filter((s) => s !== path))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void engineClient.finetune.pickSources().then(addPaths)}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          Browse files / folders…
        </button>
        <button
          type="button"
          disabled={busy || sources.length === 0}
          onClick={onPreview}
          className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-40"
        >
          Preview &amp; format
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reload()}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      <div className="flex gap-2">
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          placeholder="Or paste a path (file or folder)"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && manualPath.trim()) {
              addPaths([manualPath.trim()])
              setManualPath('')
            }
          }}
        />
        <button
          type="button"
          className="rounded-lg border border-zinc-600 px-3 text-xs"
          onClick={() => {
            if (manualPath.trim()) {
              addPaths([manualPath.trim()])
              setManualPath('')
            }
          }}
        >
          Add
        </button>
      </div>

      {sources.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
          No sources yet. Browse for JSONL, JSON, CSV, or a folder of training files.
        </p>
      ) : (
        <ul className="space-y-2">
          {sources.map((path) => {
            const info = inspects[path]
            return (
              <li
                key={path}
                className={`rounded-xl border p-3 ${
                  info?.exists === false ? 'border-rose-800/50 bg-rose-950/20' : 'border-zinc-800 bg-zinc-900/50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="break-all font-mono text-xs text-zinc-200">{path}</p>
                  <button
                    type="button"
                    onClick={() => removePath(path)}
                    className="shrink-0 text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
                {info && (
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {info.kind}
                    {info.extension ? ` · ${info.extension}` : ''}
                    {info.sizeBytes != null ? ` · ${formatBytes(info.sizeBytes)}` : ''}
                    {info.estimatedRows != null ? ` · ~${info.estimatedRows} rows` : ''}
                    {info.hint ? ` · ${info.hint}` : ''}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {preview ? (
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase text-zinc-500">Format preview</h4>
          <pre className="max-h-40 overflow-auto rounded-lg bg-zinc-950 p-3 text-[10px] text-zinc-400">{preview}</pre>
        </div>
      ) : null}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-200">Saved presets</h3>
        <p className="mt-1 text-[10px] text-zinc-500">Reuse common dataset path combinations.</p>
        <div className="mt-3 flex gap-2">
          <input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Preset name"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            disabled={busy || sources.length === 0}
            onClick={() =>
              void engineClient.finetune
                .savePreset({ name: presetName || `Preset ${presets.length + 1}`, sources, modality })
                .then(() => {
                  setPresetName('')
                  return reload()
                })
            }
            className="rounded-lg border border-indigo-700 bg-indigo-950/40 px-3 py-1.5 text-xs text-indigo-200 disabled:opacity-40"
          >
            Save preset
          </button>
        </div>
        {presets.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-600">No presets saved.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {presets.map((p) => {
              const presetSources = Array.isArray(p.sources) ? p.sources : []
              return (
              <li key={p.id} className="flex items-center justify-between rounded-lg bg-zinc-950/80 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-zinc-200">{p.name}</p>
                  <p className="text-[10px] text-zinc-500">
                    {p.modality} · {presetSources.length} path(s)
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="text-[10px] text-indigo-400 hover:underline"
                    onClick={() => onSourcesChange(presetSources)}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    className="text-[10px] text-red-400 hover:underline"
                    onClick={() => void engineClient.finetune.deletePreset(p.id).then(reload)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            )})}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-200">Prepared datasets</h3>
        <p className="mt-1 font-mono text-[10px] text-zinc-600">{root}</p>
        {prepared.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-600">Run Preview &amp; format to create train.jsonl bundles.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {prepared.map((d) => (
              <li key={d.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                <p className="text-xs font-medium text-zinc-200">{d.name}</p>
                <p className="text-[10px] text-zinc-500">
                  {d.sampleCount} samples · {new Date(d.createdAt).toLocaleString()}
                </p>
                <p className="mt-1 truncate font-mono text-[9px] text-zinc-600">{d.trainPath}</p>
                <button
                  type="button"
                  className="mt-2 text-[10px] text-red-400 hover:underline"
                  onClick={() => void engineClient.finetune.deletePrepared(d.id).then(reload)}
                >
                  Delete prepared bundle
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
