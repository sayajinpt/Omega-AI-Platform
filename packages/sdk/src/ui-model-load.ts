import { loadProgressLabel } from './load-progress.js'
import { modelIdsMatch, normalizeModelId } from './model-id.js'

/** Progress event pushed from main/engine during model.load. */
export interface ModelLoadProgressEvent {
  modelId: string
  phase: string
  detail?: string
  percent?: number
}

export interface ModelLoadCommandResult {
  activeModel: string
  loaded: boolean
  nativeLoaded: string | null
}

export function formatModelLoadProgress(event: ModelLoadProgressEvent): {
  percent: number
  status: string
} {
  return {
    percent: event.percent ?? 0,
    status: event.detail || loadProgressLabel(event.phase, event.detail)
  }
}

export function describeModelLoadResult(
  result: ModelLoadCommandResult,
  modelId: string,
  opts?: { isRemote?: boolean; style?: 'default' | 'installed' }
): string {
  const norm = normalizeModelId(modelId)
  if (opts?.isRemote) return `Cloud API ready: ${norm}`
  const inMemory =
    result.loaded || (result.nativeLoaded != null && modelIdsMatch(result.nativeLoaded, norm))
  if (opts?.style === 'installed') {
    return inMemory
      ? `Loaded ${norm} into memory (VRAM/RAM in use)`
      : `Selected ${norm} (will load on first message)`
  }
  return inMemory ? `Loaded ${norm}` : `Selected ${norm} (loads on first message)`
}
