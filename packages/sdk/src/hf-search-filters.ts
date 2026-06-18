import type { HFSearchResult } from './index.js'

/** Sentinel max values — at these limits the bound is treated as "no limit". */
export const PARAM_B_MAX = 500
export const CONTEXT_K_MAX = 2048
export const DOWNLOADS_MAX = 50_000_000
export const FILE_GB_MAX = 250

export type ModelSearchFilterState = {
  paramsMinB: number
  paramsMaxB: number
  contextMinK: number
  contextMaxK: number
  downloadsMin: number
  downloadsMax: number
  pipeline: string
  quant: string
  fileMinGb: number
  fileMaxGb: number
}

export const defaultModelSearchFilters = (): ModelSearchFilterState => ({
  paramsMinB: 0,
  paramsMaxB: PARAM_B_MAX,
  contextMinK: 0,
  contextMaxK: CONTEXT_K_MAX,
  downloadsMin: 0,
  downloadsMax: DOWNLOADS_MAX,
  pipeline: '',
  quant: '',
  fileMinGb: 0,
  fileMaxGb: FILE_GB_MAX
})

export function filtersAreActive(f: ModelSearchFilterState): boolean {
  return (
    f.paramsMinB > 0 ||
    f.paramsMaxB < PARAM_B_MAX ||
    f.contextMinK > 0 ||
    f.contextMaxK < CONTEXT_K_MAX ||
    f.downloadsMin > 0 ||
    f.downloadsMax < DOWNLOADS_MAX ||
    Boolean(f.pipeline.trim()) ||
    Boolean(f.quant.trim()) ||
    f.fileMinGb > 0 ||
    f.fileMaxGb < FILE_GB_MAX
  )
}

/** Parse parameter scale (billions) from repo id / HF tags. */
export function inferParamBillions(id: string, tags: string[] = []): number | null {
  const hay = `${id} ${tags.join(' ')}`.toLowerCase()
  const moeActive = hay.match(/(\d+(?:\.\d+)?)\s*b[-/](\d+(?:\.\d+)?)\s*b/)
  if (moeActive) {
    const active = Number.parseFloat(moeActive[1] ?? '')
    if (Number.isFinite(active)) return active
  }
  const sizes = [...hay.matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z])/gi)].map((m) =>
    Number.parseFloat(m[1] ?? '')
  )
  const valid = sizes.filter((n) => Number.isFinite(n) && n > 0 && n < 2000)
  if (valid.length === 0) return null
  return Math.max(...valid)
}

/** Parse context window in tokens from id / tags (returns thousands of tokens = K). */
export function inferContextK(id: string, tags: string[] = []): number | null {
  const hay = `${id} ${tags.join(' ')}`.toLowerCase()
  if (/\b(10m|1m)\s*ctx\b|\b10m\s*context\b|\b1m\s*context\b/.test(hay)) {
    return /\b10m\b/.test(hay) ? 10_000 : 1_000
  }
  if (tags.some((t) => /long[- ]?context/i.test(t))) return 128
  const kMatch = hay.match(/(\d+(?:\.\d+)?)\s*k(?:\s*ctx|\s*context|-context)?\b/)
  if (kMatch) {
    const k = Number.parseFloat(kMatch[1] ?? '')
    if (Number.isFinite(k)) return k
  }
  const raw = hay.match(/\b(\d{4,6})\s*(?:ctx|context|tokens?)\b/)
  if (raw) {
    const n = Number.parseInt(raw[1] ?? '', 10)
    if (Number.isFinite(n) && n >= 1024) return Math.round(n / 1024)
  }
  return null
}

export function passesHfResultFilters(r: HFSearchResult, f: ModelSearchFilterState): boolean {
  if (!filtersAreActive(f)) return true

  if (f.pipeline.trim()) {
    const want = f.pipeline.trim().toLowerCase()
    const pipe = (r.pipeline ?? '').toLowerCase()
    if (pipe !== want && !r.tags.some((t) => t.toLowerCase() === want)) return false
  }

  const params = inferParamBillions(r.id, r.tags)
  if (f.paramsMinB > 0 && (params === null || params < f.paramsMinB)) return false
  if (f.paramsMaxB < PARAM_B_MAX && (params === null || params > f.paramsMaxB)) return false

  const ctx = inferContextK(r.id, r.tags)
  if (f.contextMinK > 0 && (ctx === null || ctx < f.contextMinK)) return false
  if (f.contextMaxK < CONTEXT_K_MAX && (ctx === null || ctx > f.contextMaxK)) return false

  if (f.downloadsMin > 0 && r.downloads < f.downloadsMin) return false
  if (f.downloadsMax < DOWNLOADS_MAX && r.downloads > f.downloadsMax) return false

  return true
}

export function passesHubSizeGb(sizeGb: number | undefined, f: ModelSearchFilterState): boolean {
  if (f.fileMinGb <= 0 && f.fileMaxGb >= FILE_GB_MAX) return true
  if (sizeGb === undefined) return f.fileMinGb <= 0
  if (f.fileMinGb > 0 && sizeGb < f.fileMinGb) return false
  if (f.fileMaxGb < FILE_GB_MAX && sizeGb > f.fileMaxGb) return false
  return true
}

export function passesFileSizeBytes(sizeBytes: number, f: ModelSearchFilterState): boolean {
  if (f.fileMinGb <= 0 && f.fileMaxGb >= FILE_GB_MAX) return true
  const gb = sizeBytes / 1024 ** 3
  if (f.fileMinGb > 0 && gb < f.fileMinGb) return false
  if (f.fileMaxGb < FILE_GB_MAX && gb > f.fileMaxGb) return false
  return true
}

export function passesHubEntry(
  entry: { repo: string; params: string; tags: string[]; sizeGb?: number },
  f: ModelSearchFilterState
): boolean {
  if (!filtersAreActive(f)) return true
  const pseudo: HFSearchResult = {
    id: entry.repo,
    modelId: entry.repo,
    author: entry.repo.split('/')[0] ?? '',
    downloads: 0,
    likes: 0,
    lastModified: '',
    tags: entry.tags,
    pipeline: undefined
  }
  if (!passesHfResultFilters(pseudo, f)) return false
  if (!passesHubSizeGb(entry.sizeGb, f)) return false
  const params = inferParamBillions(entry.repo, entry.tags) ?? inferParamBillions(entry.params, [])
  if (f.paramsMinB > 0 && (params === null || params < f.paramsMinB)) return false
  if (f.paramsMaxB < PARAM_B_MAX && (params === null || params > f.paramsMaxB)) return false
  return true
}
