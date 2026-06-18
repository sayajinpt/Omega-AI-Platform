export const COMPANION_HIDDEN_KEY = 'omega.avatar.hidden'
export const COMPANION_COLLAPSED_KEY = 'omega.avatar.collapsed'
export const COMPANION_EXPAND_EVENT = 'omega:companion-expand'

/** Missing key means visible (default on first run). */
export function isCompanionHidden(): boolean {
  try {
    const v = localStorage.getItem(COMPANION_HIDDEN_KEY)
    if (v === null) return false
    return v === '1'
  } catch {
    return false
  }
}

export function ensureCompanionVisibleDefault(): void {
  try {
    if (localStorage.getItem(COMPANION_HIDDEN_KEY) === null) {
      localStorage.setItem(COMPANION_HIDDEN_KEY, '0')
    }
  } catch {
    /* ignore */
  }
}

export function setCompanionHidden(hidden: boolean): void {
  try {
    localStorage.setItem(COMPANION_HIDDEN_KEY, hidden ? '1' : '0')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent('omega:companion-visibility', { detail: { hidden } })
  )
}

export function requestCompanionExpand(): void {
  window.dispatchEvent(new CustomEvent(COMPANION_EXPAND_EVENT))
}
