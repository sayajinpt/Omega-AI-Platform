export type PanelLayoutPrefs = {
  leftWidth: number
  leftHidden: boolean
  navWidth: number
  navHidden: boolean
}

const defaults = (leftWidth: number, navWidth: number): PanelLayoutPrefs => ({
  leftWidth,
  leftHidden: false,
  navWidth,
  navHidden: false
})

export function loadLayoutPrefs(key: string, leftWidth: number, navWidth = 224): PanelLayoutPrefs {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return defaults(leftWidth, navWidth)
    const parsed = JSON.parse(raw) as Partial<PanelLayoutPrefs>
    return {
      leftWidth: clamp(parsed.leftWidth ?? leftWidth, 160, 480),
      leftHidden: Boolean(parsed.leftHidden),
      navWidth: clamp(parsed.navWidth ?? navWidth, 160, 360),
      navHidden: Boolean(parsed.navHidden)
    }
  } catch {
    return defaults(leftWidth, navWidth)
  }
}

export function saveLayoutPrefs(key: string, prefs: PanelLayoutPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(prefs))
  } catch {
    /* ignore quota */
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
