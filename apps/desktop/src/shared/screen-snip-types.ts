/** Virtual desktop bounds (all displays union) in screen coordinates. */
export type VirtualDesktopBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type ScreenSnipRect = {
  x: number
  y: number
  width: number
  height: number
}

export type ScreenSnipCaptureResult = {
  /** Temp PNG on disk (for save dialog). */
  tempPath: string
  /** data:image/png;base64,... for UI preview */
  previewDataUrl: string
  width: number
  height: number
}
