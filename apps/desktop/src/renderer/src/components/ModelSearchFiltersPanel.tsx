import { Slider } from './Slider'
import {
  CONTEXT_K_MAX,
  DOWNLOADS_MAX,
  FILE_GB_MAX,
  PARAM_B_MAX,
  type ModelSearchFilterState,
  filtersAreActive
} from '../lib/model-search-filters'

function formatK(v: number): string {
  if (v >= CONTEXT_K_MAX) return 'any'
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}M`
  return `${v}K`
}

function formatDownloads(v: number): string {
  if (v >= DOWNLOADS_MAX) return 'any'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${Math.round(v / 1000)}K`
  return String(v)
}

function formatGb(v: number): string {
  if (v >= FILE_GB_MAX) return 'any'
  if (v < 0.1) return '0 GB'
  return `${v.toFixed(v < 10 ? 1 : 0)} GB`
}

function formatB(v: number): string {
  if (v >= PARAM_B_MAX) return 'any'
  return `${v}B`
}

export function ModelSearchFiltersPanel({
  filters,
  onChange,
  onReset,
  pipelineOptions,
  showFileSize = true,
  showQuant = false
}: {
  filters: ModelSearchFilterState
  onChange: (next: ModelSearchFilterState) => void
  onReset: () => void
  pipelineOptions?: string[]
  showFileSize?: boolean
  showQuant?: boolean
}) {
  const active = filtersAreActive(filters)
  const patch = (partial: Partial<ModelSearchFilterState>) => onChange({ ...filters, ...partial })

  return (
    <details
      className="rounded-lg border border-zinc-800 bg-zinc-950/80"
      open={active}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-300">
        Filters
        {active ? (
          <span className="ml-2 font-normal text-indigo-400">active</span>
        ) : (
          <span className="ml-2 font-normal text-zinc-600">optional</span>
        )}
      </summary>
      <div className="space-y-3 border-t border-zinc-800 px-3 py-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Slider
            label="Parameters (min)"
            hint="Active / dense size in billions"
            min={0}
            max={PARAM_B_MAX}
            step={1}
            value={filters.paramsMinB}
            onChange={(v) => patch({ paramsMinB: Math.min(v, filters.paramsMaxB) })}
            format={formatB}
            presets={[
              { label: '0', value: 0 },
              { label: '7B+', value: 7 },
              { label: '13B+', value: 13 }
            ]}
          />
          <Slider
            label="Parameters (max)"
            min={0}
            max={PARAM_B_MAX}
            step={1}
            value={filters.paramsMaxB}
            onChange={(v) => patch({ paramsMaxB: Math.max(v, filters.paramsMinB) })}
            format={formatB}
            presets={[
              { label: 'any', value: PARAM_B_MAX },
              { label: '14B', value: 14 },
              { label: '32B', value: 32 },
              { label: '70B', value: 70 }
            ]}
          />
          <Slider
            label="Context (min)"
            hint="Inferred from name / tags (K tokens)"
            min={0}
            max={CONTEXT_K_MAX}
            step={4}
            value={filters.contextMinK}
            onChange={(v) => patch({ contextMinK: Math.min(v, filters.contextMaxK) })}
            format={formatK}
            presets={[
              { label: '0', value: 0 },
              { label: '8K+', value: 8 },
              { label: '32K+', value: 32 }
            ]}
          />
          <Slider
            label="Context (max)"
            min={0}
            max={CONTEXT_K_MAX}
            step={4}
            value={filters.contextMaxK}
            onChange={(v) => patch({ contextMaxK: Math.max(v, filters.contextMinK) })}
            format={formatK}
            presets={[
              { label: 'any', value: CONTEXT_K_MAX },
              { label: '32K', value: 32 },
              { label: '128K', value: 128 },
              { label: '256K', value: 256 }
            ]}
          />
          <Slider
            label="Hub downloads (min)"
            min={0}
            max={DOWNLOADS_MAX}
            step={10_000}
            value={filters.downloadsMin}
            onChange={(v) => patch({ downloadsMin: Math.min(v, filters.downloadsMax) })}
            format={formatDownloads}
          />
          <Slider
            label="Hub downloads (max)"
            min={0}
            max={DOWNLOADS_MAX}
            step={10_000}
            value={filters.downloadsMax}
            onChange={(v) => patch({ downloadsMax: Math.max(v, filters.downloadsMin) })}
            format={formatDownloads}
          />
        </div>

        {showFileSize && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Slider
              label="File size (min)"
              hint="Catalog ≈ GB; HF files when viewing a repo"
              min={0}
              max={FILE_GB_MAX}
              step={0.5}
              value={filters.fileMinGb}
              onChange={(v) => patch({ fileMinGb: Math.min(v, filters.fileMaxGb) })}
              format={formatGb}
              presets={[
                { label: '0', value: 0 },
                { label: '4GB+', value: 4 },
                { label: '8GB+', value: 8 }
              ]}
            />
            <Slider
              label="File size (max)"
              min={0}
              max={FILE_GB_MAX}
              step={0.5}
              value={filters.fileMaxGb}
              onChange={(v) => patch({ fileMaxGb: Math.max(v, filters.fileMinGb) })}
              format={formatGb}
              presets={[
                { label: 'any', value: FILE_GB_MAX },
                { label: '8GB', value: 8 },
                { label: '24GB', value: 24 },
                { label: '48GB', value: 48 }
              ]}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {pipelineOptions && pipelineOptions.length > 0 && (
            <select
              value={filters.pipeline}
              onChange={(e) => patch({ pipeline: e.target.value })}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
            >
              <option value="">Any pipeline</option>
              {pipelineOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {showQuant && (
            <select
              value={filters.quant}
              onChange={(e) => patch({ quant: e.target.value })}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
            >
              <option value="">Any quant</option>
              {['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'IQ4_XS', 'F16'].map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          )}
          {active && (
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg border border-zinc-600 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
            >
              Reset filters
            </button>
          )}
        </div>
        <p className="text-[10px] text-zinc-600">
          Parameter and context limits use heuristics from repo names and HF tags. Models without
          a detectable value are hidden when a min bound is set.
        </p>
      </div>
    </details>
  )
}
