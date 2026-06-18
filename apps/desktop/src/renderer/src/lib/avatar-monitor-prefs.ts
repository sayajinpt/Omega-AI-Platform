import { avatarMonitorSize } from '../../../shared/avatar-layout'
import { engineClient } from './engine'
export const AVATAR_MONITOR_KEY = 'omega.avatar.monitor'
export const AVATAR_SCALE_KEY = 'omega.avatar.scale'

export function loadAvatarScale(): number {
  try {
    const raw = localStorage.getItem(AVATAR_SCALE_KEY)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n)) return n
    }
  } catch {
    /* ignore */
  }
  return 1.35
}

export type AvatarMonitorAnchor = {
  /** Screen X of companion top-left (pass when detaching from in-window widget). */
  screenX: number
  screenY: number
}

/** Screen position for the detached overlay (saved in-window pos or bottom-right of main window). */
export function resolveAvatarMonitorAnchor(anchor?: AvatarMonitorAnchor): AvatarMonitorAnchor {
  if (anchor) return anchor
  try {
    const raw = localStorage.getItem('omega.avatar.pos')
    if (raw) {
      const pos = JSON.parse(raw) as { x: number; y: number }
      return {
        screenX: Math.round(window.screenX + pos.x),
        screenY: Math.round(window.screenY + pos.y)
      }
    }
  } catch {
    /* ignore */
  }
  return {
    screenX: Math.round(window.screenX + window.innerWidth - 200),
    screenY: Math.round(window.screenY + window.innerHeight - 240)
  }
}

export async function setAvatarMonitorEnabled(
  enabled: boolean,
  anchor?: AvatarMonitorAnchor
): Promise<boolean> {
  if (enabled) {
    const { screenX, screenY } = resolveAvatarMonitorAnchor(anchor)
    const collapsed = false
    const scale = loadAvatarScale()
    const { width, height } = avatarMonitorSize(false, scale)
    const r = await engineClient.avatarMonitor.setEnabled(true, {
      x: screenX,
      y: screenY,
      collapsed,
      scale,
      width,
      height
    })
    try {
      localStorage.setItem(AVATAR_MONITOR_KEY, r.enabled ? '1' : '0')
    } catch {
      /* ignore */
    }
    return r.enabled
  }
  const r = await engineClient.avatarMonitor.setEnabled(false)
  try {
    localStorage.setItem(AVATAR_MONITOR_KEY, '0')
  } catch {
    /* ignore */
  }
  return r.enabled
}

/** Hide or show the detached overlay without attaching back to the main window. */
export async function setAvatarMonitorOverlayVisible(visible: boolean): Promise<boolean> {
  const r = await engineClient.avatarMonitor.setOverlayVisible(visible)
  return Boolean(r.overlayVisible ?? visible)
}
