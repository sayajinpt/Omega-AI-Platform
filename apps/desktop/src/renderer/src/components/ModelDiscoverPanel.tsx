import { engineClient } from '../lib/engine'
import { useMemo, useState } from 'react'
import type { HubEntry } from '../data/model-hub'
import { MODEL_HUB } from '../data/model-hub'
import { normalizeModelId } from '../lib/model-id'
import type { ModelInfo } from '@omega/sdk'

const CATEGORIES: Array<{ id: HubEntry['category'] | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'coder', label: 'Coding' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'vision', label: 'Vision' },
  { id: 'tools', label: 'Tools' },
  { id: 'small', label: 'Compact' },
  { id: 'large', label: 'Large' },
  { id: 'embedding', label: 'Embed' },
  { id: 'math', label: 'Math' }
]

const CATEGORY_ACCENT: Record<HubEntry['category'], string> = {
  chat: 'from-indigo-500/80 via-violet-500/40 to-transparent',
  coder: 'from-emerald-500/80 via-teal-500/30 to-transparent',
  reasoning: 'from-amber-500/80 via-orange-500/30 to-transparent',
  vision: 'from-fuchsia-500/80 via-pink-500/30 to-transparent',
  embedding: 'from-cyan-500/80 via-sky-500/30 to-transparent',
  math: 'from-rose-500/80 via-red-500/30 to-transparent',
  small: 'from-zinc-400/70 via-zinc-500/20 to-transparent',
  large: 'from-purple-500/80 via-indigo-600/30 to-transparent',
  tools: 'from-blue-500/80 via-indigo-500/30 to-transparent'
}

const TAG_STYLES: Record<string, string> = {
  new: 'bg-emerald-950/60 text-emerald-300 ring-emerald-700/50',
  popular: 'bg-indigo-950/60 text-indigo-300 ring-indigo-700/50',
  recommended: 'bg-violet-950/60 text-violet-300 ring-violet-700/50',
  flagship: 'bg-amber-950/60 text-amber-200 ring-amber-700/50',
  moe: 'bg-sky-950/60 text-sky-300 ring-sky-700/50',
  agent: 'bg-fuchsia-950/60 text-fuchsia-300 ring-fuchsia-700/50',
  cpu: 'bg-zinc-800/80 text-zinc-300 ring-zinc-600/50',
  legacy: 'bg-zinc-900/80 text-zinc-500 ring-zinc-700/40'
}

function hubCardTags(entry: HubEntry): string[] {
  const primary = entry.tags.filter((t) =>
    ['new', 'popular', 'recommended', 'flagship', 'moe', 'agent', 'cpu', 'legacy'].includes(t)
  )
  return primary.slice(0, 4)
}

function HubModelCard({
  entry,
  installed,
  fitsGpu,
  busy,
  onDownload,
  onOpenRepo
}: {
  entry: HubEntry
  installed: boolean
  fitsGpu: boolean
  busy: boolean
  onDownload: () => void
  onOpenRepo: () => void
}) {
  const accent = CATEGORY_ACCENT[entry.category]
  const displayTags = hubCardTags(entry)

  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-zinc-900/50 shadow-lg transition hover:border-zinc-600 hover:shadow-indigo-950/20 ${
        installed ? 'border-emerald-800/50' : 'border-zinc-800'
      }`}
    >
      <div className={`h-1.5 w-full bg-gradient-to-r ${accent}`} />
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-zinc-100">{entry.name}</h3>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-500">{entry.params}</p>
          </div>
          {entry.year ? (
            <span className="shrink-0 rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {entry.year}
            </span>
          ) : null}
        </div>

        <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-zinc-400">{entry.description}</p>

        {displayTags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {displayTags.map((t) => (
              <span
                key={t}
                className={`rounded-md px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ring-1 ${
                  TAG_STYLES[t] ?? 'bg-zinc-800/60 text-zinc-400 ring-zinc-700/50'
                }`}
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}

        <dl className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
          <div className="rounded-lg bg-zinc-950/80 px-2 py-1.5">
            <dt className="text-zinc-600">Quant</dt>
            <dd className="font-medium text-zinc-300">{entry.quant}</dd>
          </div>
          <div className="rounded-lg bg-zinc-950/80 px-2 py-1.5">
            <dt className="text-zinc-600">Size</dt>
            <dd className="font-medium text-zinc-300">
              {entry.sizeGb != null ? `~${entry.sizeGb} GB` : '—'}
            </dd>
          </div>
          <div className="rounded-lg bg-zinc-950/80 px-2 py-1.5">
            <dt className="text-zinc-600">VRAM</dt>
            <dd className={`font-medium ${fitsGpu ? 'text-emerald-400' : 'text-amber-300/90'}`}>
              {fitsGpu ? 'Likely OK' : 'Check GPU'}
            </dd>
          </div>
        </dl>

        <p className="mt-2 truncate font-mono text-[9px] text-zinc-600" title={entry.repo}>
          {entry.repo}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {installed ? (
            <span className="rounded-lg bg-emerald-950/50 px-3 py-1.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-800/50">
              Installed
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onDownload}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Download
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onOpenRepo}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Files &amp; README
          </button>
          <button
            type="button"
            className="rounded-lg border border-zinc-800 px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-300"
            onClick={() => void engineClient.models.openHfRepo(entry.repo)}
            title="Open on Hugging Face"
          >
            HF ↗
          </button>
        </div>
      </div>
    </article>
  )
}

export function ModelDiscoverPanel({
  models,
  busy,
  gpuTotalMb,
  onDownload,
  onOpenRepo,
  onBrowseHf
}: {
  models: ModelInfo[]
  busy: boolean
  gpuTotalMb: number
  onDownload: (repo: string, file: string) => void
  onOpenRepo: (repo: string) => void
  onBrowseHf: () => void
}) {
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [fitsOnly, setFitsOnly] = useState(false)

  const installedIds = useMemo(
    () => new Set(models.map((m) => normalizeModelId(m.id))),
    [models]
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return MODEL_HUB.filter((h) => {
      if (category !== 'all' && h.category !== category) return false
      if (q) {
        const hay = `${h.name} ${h.description} ${h.repo} ${h.tags.join(' ')} ${h.params}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (fitsOnly && gpuTotalMb > 0 && h.sizeGb != null) {
        const needMb = h.sizeGb * 1024
        if (needMb > gpuTotalMb * 0.92) return false
      }
      return true
    })
  }, [filter, category, fitsOnly, gpuTotalMb])

  const sections = useMemo(() => {
    if (category !== 'all' || filter.trim()) {
      return [{ title: `${filtered.length} models`, items: filtered }]
    }
    const new2026 = filtered.filter((h) => h.year === 2026)
    const popular = filtered.filter((h) => h.tags.includes('popular') && h.year !== 2026)
    const groupedIds = new Set([...new2026, ...popular].map((h) => h.id))
    const rest = filtered.filter((h) => !groupedIds.has(h.id))
    const out: Array<{ title: string; items: HubEntry[] }> = []
    if (new2026.length) out.push({ title: 'New in 2026', items: new2026 })
    if (popular.length) out.push({ title: 'Popular picks', items: popular })
    if (rest.length) out.push({ title: 'More models', items: rest })
    return out.length ? out : [{ title: 'Discover', items: filtered }]
  }, [filtered, category, filter])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-zinc-400">
            Curated GGUF picks with one-click download. For any model on Hugging Face, use{' '}
            <button type="button" onClick={onBrowseHf} className="text-indigo-400 hover:underline">
              Browse HF
            </button>
            .
          </p>
        </div>
        <p className="text-xs text-zinc-500">{MODEL_HUB.length} catalog entries</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, tag, family…"
          className="min-w-[12rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        {gpuTotalMb > 0 ? (
          <label className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
            <input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} />
            Fits my GPU (~{(gpuTotalMb / 1024).toFixed(0)} GB VRAM)
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCategory(c.id)}
            className={`rounded-full px-3 py-1 text-xs capitalize transition ${
              category === c.id
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center">
          <p className="text-zinc-400">No models match your filters.</p>
          <button
            type="button"
            className="mt-3 text-sm text-indigo-400 hover:underline"
            onClick={() => {
              setFilter('')
              setCategory('all')
              setFitsOnly(false)
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        sections.map((section) => (
          <section key={section.title}>
            {sections.length > 1 ? (
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {section.title}
              </h3>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {section.items.map((entry) => {
                const norm = normalizeModelId(entry.file)
                const installed = installedIds.has(norm)
                const fitsGpu =
                  gpuTotalMb <= 0 || entry.sizeGb == null || entry.sizeGb * 1024 <= gpuTotalMb * 0.92
                return (
                  <HubModelCard
                    key={entry.id}
                    entry={entry}
                    installed={installed}
                    fitsGpu={fitsGpu}
                    busy={busy}
                    onDownload={() => onDownload(entry.repo, entry.file)}
                    onOpenRepo={() => onOpenRepo(entry.repo)}
                  />
                )
              })}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
