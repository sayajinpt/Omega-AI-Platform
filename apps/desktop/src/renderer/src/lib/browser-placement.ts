import type { BrowserBounds } from '@omega/sdk'
import { engineClient } from './engine'
import { normalizeBrowserUrl } from '../../../shared/browser-open'
import { domRectToShellBounds } from './browser-bounds'

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function boundsFromElement(
  el: HTMLElement,
  minWidth = 1,
  minHeight = 1
): BrowserBounds | null {
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 8) return null
  return domRectToShellBounds(r, minWidth, minHeight)
}

/** Show embedded WebView2 over `el`, then navigate — order matters for Win32 host placement. */
export async function placeEmbeddedBrowser(
  el: HTMLElement,
  url: string,
  mode: 'mini' | 'full' = 'mini',
  minWidth = 200,
  minHeight = 120
): Promise<BrowserBounds | null> {
  const target = normalizeBrowserUrl(url)
  if (!target) return null

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

  for (let attempt = 0; attempt < 32; attempt++) {
    const bounds = boundsFromElement(el, minWidth, minHeight)
    if (bounds) {
      await engineClient.browser.show(bounds, mode)
      await engineClient.browser.setBounds(bounds)
      await engineClient.browser.navigate(target)
      return bounds
    }
    await waitMs(attempt < 6 ? 16 : 50)
  }
  return null
}

export function scheduleBoundsSettle(
  getBounds: () => BrowserBounds | null,
  cancelled: () => boolean
): number[] {
  const timers: number[] = []
  for (const delay of [0, 40, 120, 260, 500, 900]) {
    timers.push(
      window.setTimeout(() => {
        if (cancelled()) return
        const b = getBounds()
        if (b) void engineClient.browser.setBounds(b)
      }, delay)
    )
  }
  return timers
}
