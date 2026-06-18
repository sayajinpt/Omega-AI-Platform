import type { AvatarSignals } from './avatar-signals'

/** Runtime/shell publish `{ enabled: boolean }`; older paths may send a bare boolean. */
export function parseAvatarMonitorEnabledPayload(payload: unknown): boolean {
  if (typeof payload === 'boolean') return payload
  if (payload !== null && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>
    if ('enabled' in rec) return Boolean(rec.enabled)
  }
  return Boolean(payload)
}

export function parseAvatarMonitorSignalsPayload(payload: unknown): AvatarSignals | null {
  if (payload === null || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  const inner =
    rec.signals !== null && typeof rec.signals === 'object'
      ? (rec.signals as Record<string, unknown>)
      : rec
  const state = inner.state
  if (
    state !== 'idle' &&
    state !== 'thinking' &&
    state !== 'speaking' &&
    state !== 'error'
  ) {
    return null
  }
  return {
    state,
    speaking: Number(inner.speaking) || 0,
    listening: Number(inner.listening) || 0
  }
}

export type AvatarMonitorLayout = {
  x: number
  y: number
  collapsed: boolean
  scale?: number
  animationStyle?: 'neural_mesh' | 'matrix_layers' | 'spider_web'
}

export function parseAvatarMonitorLayoutPayload(payload: unknown): AvatarMonitorLayout | null {
  if (payload === null || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  const inner =
    rec.layout !== null && typeof rec.layout === 'object'
      ? (rec.layout as Record<string, unknown>)
      : rec
  if (typeof inner.x !== 'number' || typeof inner.y !== 'number') return null
  return {
    x: inner.x,
    y: inner.y,
    collapsed: Boolean(inner.collapsed),
    scale: typeof inner.scale === 'number' ? inner.scale : undefined,
    animationStyle:
      inner.animationStyle === 'neural_mesh' ||
      inner.animationStyle === 'matrix_layers' ||
      inner.animationStyle === 'spider_web'
        ? inner.animationStyle
        : undefined
  }
}
