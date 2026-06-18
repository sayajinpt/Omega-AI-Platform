import type { ScreenSnipCaptureResult } from '../../../shared/screen-snip-types'

export function SnipResultBar({
  capture,
  uiScale,
  onSave,
  onSend,
  onDismiss
}: {
  capture: ScreenSnipCaptureResult
  uiScale: number
  onSave: () => void
  onSend: () => void
  onDismiss: () => void
}) {
  const fontPx = Math.max(9, Math.round(10 * uiScale))
  const thumb = Math.round(48 * uiScale)

  return (
    <div
      className="pointer-events-auto flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-zinc-950/95 px-2 py-1.5 shadow-xl backdrop-blur-md"
      style={{ fontSize: fontPx }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <img
        src={capture.previewDataUrl}
        alt="Capture preview"
        className="rounded border border-zinc-700 object-cover"
        style={{ width: thumb, height: thumb }}
      />
      <span className="text-zinc-400">
        {capture.width}×{capture.height}
      </span>
      <button
        type="button"
        onClick={onSave}
        className="rounded-lg border border-zinc-600 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onSend}
        className="rounded-lg bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-500"
      >
        Send to chat
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded px-1 text-zinc-500 hover:text-zinc-200"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
