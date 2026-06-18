import type { BrowserBounds } from '@omega/sdk'

/**
 * Map a viewport rect to HWND client coords on `content_host`.
 * PMv2 shell + UI WebView2 use the same logical pixel space as `getBoundingClientRect`.
 */
export function domRectToShellBounds(rect: DOMRect, minWidth = 1, minHeight = 1): BrowserBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(Math.round(rect.width), minWidth),
    height: Math.max(Math.round(rect.height), minHeight)
  }
}
