import { engineClient } from '../lib/engine'
import { useCallback, useState } from 'react'
import type { HFModelCard, HFSearchResult, ModelAdapterEntry } from '@omega/sdk'
import { buildHfSearchOptions } from '@omega/sdk'

type AdapterEntry = ModelAdapterEntry | {
  repoId: string
  file: string
  scale?: number
}

function adapterFiles(card: HFModelCard): string[] {
  return card.files
    .filter((f) => /\.(safetensors|gguf)$/i.test(f.path))
    .map((f) => f.path)
    .slice(0, 24)
}

export function HfAdapterPanel({
  adapters,
  onChange,
  forGguf = false,
  downloadAdapter
}: {
  adapters: AdapterEntry[]
  onChange: (next: AdapterEntry[]) => void
  /** Chat native LoRA (GGUF) vs diffusers safetensors. */
  forGguf?: boolean
  downloadAdapter: (repoId: string, file: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HFSearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [card, setCard] = useState<HFModelCard | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const search = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const rows = await engineClient.hf.search(
        buildHfSearchOptions({
          query: query.trim() ? `${query.trim()} lora` : 'lora',
          format: forGguf ? 'gguf' : 'safetensors',
          tag: 'lora',
          sort: 'downloads',
          limit: 30,
          preferVerifiedQuantizers: false
        })
      )
      setResults(rows)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [query, forGguf])

  const pickRepo = async (repoId: string) => {
    setBusy(true)
    setMsg(null)
    try {
      setCard(await engineClient.hf.card(repoId))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
      setCard(null)
    } finally {
      setBusy(false)
    }
  }

  const attach = (repoId: string, file: string) => {
    if (adapters.some((a) => a.repoId === repoId && a.file === file)) return
    onChange([...adapters, { repoId, file, scale: 1 }])
    setCard(null)
    setMsg(`Attached ${repoId}/${file}`)
  }

  const downloadAndAttach = async (repoId: string, file: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await downloadAdapter(repoId, file)
      attach(repoId, file)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-zinc-800 bg-zinc-950/40 p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        LoRA / adapters (Hugging Face)
      </p>

      {adapters.length > 0 && (
        <ul className="space-y-1">
          {adapters.map((a, i) => (
            <li
              key={`${a.repoId}:${a.file}`}
              className="flex flex-wrap items-center gap-2 rounded border border-zinc-800/80 bg-zinc-900/50 px-2 py-1"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400">
                {a.repoId} / {a.file}
              </span>
              <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                Scale
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-zinc-200"
                  value={a.scale ?? 1}
                  onChange={(e) => {
                    const scale = Number.parseFloat(e.target.value)
                    const next = [...adapters]
                    next[i] = { ...a, scale: Number.isFinite(scale) ? scale : 1 }
                    onChange(next)
                  }}
                />
              </label>
              <button
                type="button"
                className="text-[10px] text-red-400 hover:text-red-300"
                onClick={() => onChange(adapters.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-[12rem] flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
          placeholder="Search LoRA on Hugging Face…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void search()}
          className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-600 disabled:opacity-40"
        >
          Search
        </button>
      </div>

      {results.length > 0 && !card && (
        <ul className="max-h-32 overflow-y-auto text-[10px] text-zinc-400">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="w-full truncate text-left hover:text-emerald-400"
                onClick={() => void pickRepo(r.id)}
              >
                {r.id}
              </button>
            </li>
          ))}
        </ul>
      )}

      {card && (
        <div className="max-h-40 overflow-y-auto space-y-1">
          <p className="font-mono text-[10px] text-zinc-300">{card.id}</p>
          {adapterFiles(card).map((path) => (
            <div key={path} className="flex flex-wrap items-center justify-between gap-1">
              <span className="truncate font-mono text-[10px] text-zinc-500">{path}</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="rounded bg-zinc-700 px-2 py-0.5 text-[10px] hover:bg-zinc-600"
                  onClick={() => attach(card.id, path)}
                >
                  Attach
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded bg-emerald-800 px-2 py-0.5 text-[10px] hover:bg-emerald-700 disabled:opacity-40"
                  onClick={() => void downloadAndAttach(card.id, path)}
                >
                  Download + attach
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setCard(null)}
          >
            ← Back to results
          </button>
        </div>
      )}

      {msg && <p className="text-[10px] text-zinc-500">{msg}</p>}
    </div>
  )
}
