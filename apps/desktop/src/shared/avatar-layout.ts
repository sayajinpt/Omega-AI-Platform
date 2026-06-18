/** Shared floating-avatar dimensions (main window + desktop monitor overlay). */
export const AVATAR_VIS_LAYERS = 8
export const AVATAR_SQUARE = 220
export const AVATAR_EXPANDED_W = AVATAR_SQUARE
export const AVATAR_CANVAS_H = 176
export const AVATAR_EXPANDED_CHROME_H = 32
/** @deprecated Collapsed mode removed — kept for monitor IPC compat. */
export const AVATAR_COLLAPSED_W = AVATAR_SQUARE
export const AVATAR_COLLAPSED_H = AVATAR_SQUARE
export const AVATAR_HUD_MAX_H = 0
export const AVATAR_CANVAS_PAD_V = 8
export const AVATAR_HUD_PAD_V = 0

export const AVATAR_SCALE_MIN = 0.9
export const AVATAR_SCALE_MAX = 2.75
export const AVATAR_SCALE_DEFAULT = 1.35

export function clampAvatarScale(scale: number): number {
  return Math.min(AVATAR_SCALE_MAX, Math.max(AVATAR_SCALE_MIN, scale))
}

export function avatarUiScale(scale: number): number {
  return clampAvatarScale(scale) / AVATAR_SCALE_DEFAULT
}

/** Square companion panel (always expanded). */
export function avatarMonitorSize(
  _collapsed = false,
  scale = AVATAR_SCALE_DEFAULT
): { width: number; height: number } {
  const s = clampAvatarScale(scale)
  const side = Math.round(AVATAR_SQUARE * s)
  return { width: side, height: side }
}

export function avatarExpandedMetrics(scale: number): {
  width: number
  canvasH: number
  hudMaxH: number
  chromeH: number
} {
  const s = clampAvatarScale(scale)
  const side = Math.round(AVATAR_SQUARE * s)
  const chromeH = Math.round(AVATAR_EXPANDED_CHROME_H * s)
  return {
    width: side,
    canvasH: side - chromeH - Math.round(AVATAR_CANVAS_PAD_V * s),
    hudMaxH: 0,
    chromeH
  }
}

export function avatarCollapsedMetrics(scale: number): { width: number; height: number } {
  return avatarMonitorSize(false, scale)
}

export function avatarExpandedPanelHeight(scale: number): number {
  return avatarMonitorSize(false, scale).height
}

export function avatarSquarePanelHeight(scale: number): number {
  return avatarExpandedPanelHeight(scale)
}

export function avatarExpandedGridRows(scale: number): string {
  const m = avatarExpandedMetrics(scale)
  return `${m.chromeH}px minmax(0, 1fr)`
}
