import { useMemo, useState } from 'react'
import type { ContentGenerationModelEntry } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function ContentStudioModelField({
  label,
  value,
  suggestedModels,
  installedModels,
  onChange,
  onCatalogReload,
  automaticLabel,
  kind
}: {
  label: string
  value: string
  suggestedModels: ContentGenerationModelEntry[]
  installedModels: ContentGenerationModelEntry[]
  onChange: (repoId: string) => void
  onCatalogReload?: () => void
  automaticLabel: string
  kind: 'tts' | 'image' | 'video'
}) {
  const [busyRepo, setBusyRepo] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const selectOptions = useMemo(() => {
    const seen = new Set<string>()
    const opts: Array<{ repo_id: string; label: string }> = []
    const add = (repoId: string, label: string) => {
      const id = repoId.trim()
      if (!id || seen.has(id)) return
      seen.add(id)
      opts.push({ repo_id: id, label: label || id })
    }
    for (const m of installedModels) {
      add(m.repo_id, m.key || m.repo_id)
    }
    for (const m of suggestedModels) {
      const onDisk =
        Boolean(m.on_disk) ||
        installedModels.some((i) => i.repo_id === m.repo_id && (i.on_disk ?? true))
      if (onDisk) add(m.repo_id, m.key || m.repo_id)
    }
    const pin = value.trim()
    if (pin && !seen.has(pin)) {
      add(pin, `${pin} (pinned)`)
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label))
  }, [installedModels, suggestedModels, value])

  const selectedMeta =
    suggestedModels.find((m) => m.repo_id === value) ??
    installedModels.find((m) => m.repo_id === value)

  const runDownload = async (entry: ContentGenerationModelEntry): Promise<void> => {
    setBusyRepo(entry.repo_id)
    setMsg(null)
    try {
      const result = (await engineClient.contentStudio.generation.downloadModel(
        kind,
        entry.repo_id,
        entry.key,
        entry.size
      )) as { repoId?: string; async?: boolean; accepted?: boolean }
      if (result.async || result.accepted) {
        setMsg(
          `Download started for ${entry.repo_id}. Track progress in Model Studio → Download queue.`
        )
      } else {
        setMsg(`Downloaded ${result.repoId ?? entry.repo_id}`)
        onChange(entry.repo_id)
        onCatalogReload?.()
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyRepo(null)
    }
  }

  return (
    <div className="block text-sm">
      <span className="text-zinc-300">{label}</span>
      <select
        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{automaticLabel}</option>
        {selectOptions.length === 0 ? (
          <option value="" disabled>
            No downloaded models yet — use a suggestion below
          </option>
        ) : (
          selectOptions.map((m) => (
            <option key={m.repo_id} value={m.repo_id}>
              {m.label}
            </option>
          ))
        )}
      </select>
      {selectedMeta?.description && (
        <p className="mt-1 text-[10px] text-zinc-500">{selectedMeta.description}</p>
      )}

      {suggestedModels.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Suggested download
          </p>
          <p className="text-[10px] text-zinc-600">
            Progress appears in Model Studio → Download queue as &quot;(Content Studio snapshot)&quot;.
            Downloads run one at a time — start the next after the previous finishes.
          </p>
          <p className="text-[10px] text-zinc-600">
            Manual install folder:{' '}
            <code className="text-zinc-500">
              %USERPROFILE%\.omega\models\generation-models\{kind}\Org__Repo
            </code>{' '}
            (replace <code className="text-zinc-500">/</code> in the repo id with{' '}
            <code className="text-zinc-500">__</code>, or use nested{' '}
            <code className="text-zinc-500">Org\Repo</code> folders). Weights must include a
            valid model file (e.g. config.json or a large .safetensors).
          </p>
          {suggestedModels.map((m) => {
            const busy = busyRepo === m.repo_id
            const onDisk =
              Boolean(m.on_disk) ||
              installedModels.some((i) => i.repo_id === m.repo_id && (i.on_disk ?? true))
            return (
              <div
                key={m.repo_id}
                className="flex flex-wrap items-start justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/60 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-zinc-200">{m.key}</p>
                  <p className="truncate font-mono text-[10px] text-zinc-500">{m.repo_id}</p>
                  {m.description && (
                    <p className="mt-0.5 text-[10px] text-zinc-500">{m.description}</p>
                  )}
                  {m.size && <p className="text-[10px] text-zinc-600">{m.size}</p>}
                  {onDisk && (
                    <p className="mt-0.5 text-[10px] text-emerald-500/90">Already on disk</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={Boolean(busyRepo)}
                  onClick={() => void runDownload(m)}
                  className="shrink-0 rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  {busy ? 'Downloading…' : onDisk ? 'Re-download' : 'Download'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {value && (
        <button
          type="button"
          disabled={Boolean(busyRepo)}
          onClick={() => {
            const entry =
              suggestedModels.find((m) => m.repo_id === value) ??
              installedModels.find((m) => m.repo_id === value)
            if (entry) void runDownload(entry)
          }}
          className="mt-2 rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
        >
          Download selected model
        </button>
      )}

      {msg && (
        <p
          className={`mt-1 text-[10px] ${/failed|error|token|python|incomplete/i.test(msg) ? 'text-rose-300' : 'text-zinc-400'}`}
        >
          {msg}
        </p>
      )}
    </div>
  )
}
