/** Map native load phases to UI progress (0–100). */
export const LOAD_PROGRESS_PERCENT: Record<string, number> = {
  start: 5,
  prepare: 10,
  path: 15,
  gpu: 28,
  weights: 55,
  context: 82,
  ollama: 40,
  runtime: 45,
  ready: 100
}

export function loadProgressPercent(phase: string, prev = 0): number {
  const p = LOAD_PROGRESS_PERCENT[phase]
  if (p === undefined) return Math.min(99, prev + 2)
  return Math.max(prev, p)
}

export function loadProgressLabel(phase: string, detail?: string): string {
  if (detail) return detail
  switch (phase) {
    case 'start':
      return 'Starting…'
    case 'prepare':
      return 'Preparing model…'
    case 'path':
      return 'Resolving model file…'
    case 'gpu':
      return 'Initializing GPU/CPU backend…'
    case 'weights':
      return 'Loading weights into memory…'
    case 'context':
      return 'Creating context…'
    case 'ready':
      return 'Ready'
    case 'ollama':
      return 'Starting Ollama engine…'
    case 'runtime':
      return 'Starting runtime…'
    default:
      return phase
  }
}
