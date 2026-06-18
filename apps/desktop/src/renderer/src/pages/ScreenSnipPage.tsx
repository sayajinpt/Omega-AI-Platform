import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScreenSnipRect, VirtualDesktopBounds } from '../../../shared/screen-snip-types'
import { engineClient } from '../lib/engine'

type DragMode = 'new' | 'move' | 'resize'
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const MIN_SIZE = 12

function normalizeRect(x0: number, y0: number, x1: number, y1: number): ScreenSnipRect {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }
}

export function ScreenSnipPage() {
  const [bounds, setBounds] = useState<VirtualDesktopBounds | null>(null)
  const [rect, setRect] = useState<ScreenSnipRect | null>(null)
  const [dragMode, setDragMode] = useState<DragMode | null>(null)
  const [handle, setHandle] = useState<Handle | null>(null)
  const dragStart = useRef<{ sx: number; sy: number; rect: ScreenSnipRect } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const off = engineClient.screenSnip.onInit((b) => setBounds(b))
    void engineClient.screenSnip.getBounds().then((b) => {
      if (b) setBounds(b)
    })
    return off
  }, [])

  const toLocal = useCallback(
    (screenX: number, screenY: number): { x: number; y: number } => {
      if (!bounds) return { x: screenX, y: screenY }
      return { x: screenX - bounds.x, y: screenY - bounds.y }
    },
    [bounds]
  )

  const toScreenRect = useCallback(
    (local: ScreenSnipRect): ScreenSnipRect => {
      if (!bounds) return local
      return {
        x: local.x + bounds.x,
        y: local.y + bounds.y,
        width: local.width,
        height: local.height
      }
    },
    [bounds]
  )

  const clampLocal = useCallback(
    (r: ScreenSnipRect): ScreenSnipRect => {
      const maxW = bounds?.width ?? 4096
      const maxH = bounds?.height ?? 4096
      const w = Math.min(maxW, Math.max(MIN_SIZE, r.width))
      const h = Math.min(maxH, Math.max(MIN_SIZE, r.height))
      const x = Math.max(0, Math.min(maxW - w, r.x))
      const y = Math.max(0, Math.min(maxH - h, r.y))
      return { x, y, width: w, height: h }
    },
    [bounds]
  )

  const cancel = useCallback(() => {
    void engineClient.screenSnip.cancel()
  }, [])

  const submit = useCallback(async () => {
    if (!rect || submitting) return
    setSubmitting(true)
    try {
      await engineClient.screenSnip.submit(toScreenRect(rect))
    } catch {
      cancel()
    }
  }, [rect, submitting, toScreenRect, cancel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
      if (e.key === 'Enter' && rect) {
        e.preventDefault()
        void submit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel, submit, rect])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (submitting || !bounds) return
    const p = toLocal(e.screenX, e.screenY)
    if (rect) {
      const inside =
        p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
      if (inside) {
        setDragMode('move')
        dragStart.current = { sx: p.x, sy: p.y, rect: { ...rect } }
        return
      }
    }
    setDragMode('new')
    dragStart.current = { sx: p.x, sy: p.y, rect: { x: p.x, y: p.y, width: 0, height: 0 } }
    setRect({ x: p.x, y: p.y, width: 0, height: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragStart.current || !dragMode) return
    const p = toLocal(e.screenX, e.screenY)
    const start = dragStart.current

    if (dragMode === 'new') {
      setRect(clampLocal(normalizeRect(start.sx, start.sy, p.x, p.y)))
      return
    }

    if (dragMode === 'move') {
      const dx = p.x - start.sx
      const dy = p.y - start.sy
      setRect(
        clampLocal({
          x: start.rect.x + dx,
          y: start.rect.y + dy,
          width: start.rect.width,
          height: start.rect.height
        })
      )
      return
    }

    if (dragMode === 'resize' && handle) {
      let { x, y, width, height } = start.rect
      const right = x + width
      const bottom = y + height
      if (handle.includes('e')) width = Math.max(MIN_SIZE, p.x - x)
      if (handle.includes('s')) height = Math.max(MIN_SIZE, p.y - y)
      if (handle.includes('w')) {
        const nr = right
        x = Math.min(p.x, nr - MIN_SIZE)
        width = nr - x
      }
      if (handle.includes('n')) {
        const nb = bottom
        y = Math.min(p.y, nb - MIN_SIZE)
        height = nb - y
      }
      setRect(clampLocal({ x, y, width, height }))
    }
  }

  const onPointerUp = (): void => {
    setDragMode(null)
    setHandle(null)
    dragStart.current = null
  }

  const startResize = (h: Handle) => (e: React.PointerEvent): void => {
    e.stopPropagation()
    if (!rect) return
    setDragMode('resize')
    setHandle(h)
    dragStart.current = { sx: e.screenX, sy: e.screenY, rect: { ...rect } }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  if (!bounds) {
    return <div className="fixed inset-0 bg-black/40" />
  }

  const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      style={{ width: bounds.width, height: bounds.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="absolute inset-0 bg-black/45" aria-hidden />

      {rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE && (
        <>
          <div
            className="absolute border-2 border-cyan-400 bg-cyan-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)'
            }}
          />
          {handles.map((h) => (
            <span
              key={h}
              className="absolute z-10 h-2.5 w-2.5 rounded-sm border border-white bg-cyan-400"
              style={{
                left: h.includes('w') ? rect.x - 5 : h.includes('e') ? rect.x + rect.width - 5 : rect.x + rect.width / 2 - 5,
                top: h.includes('n') ? rect.y - 5 : h.includes('s') ? rect.y + rect.height - 5 : rect.y + rect.height / 2 - 5,
                cursor: `${h}-resize`
              }}
              onPointerDown={startResize(h)}
            />
          ))}
        </>
      )}

      <div className="pointer-events-none absolute left-0 right-0 top-3 flex justify-center">
        <p className="rounded-lg bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-200 shadow-lg">
          Drag to select · resize corners · <kbd className="text-cyan-300">Enter</kbd> capture ·{' '}
          <kbd className="text-zinc-400">Esc</kbd> cancel
        </p>
      </div>

      {rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE && (
        <div
          className="pointer-events-auto absolute flex items-center gap-2 rounded-lg border border-zinc-600 bg-zinc-900/95 px-2 py-1.5 text-xs text-zinc-100 shadow-xl"
          style={{
            left: Math.min(rect.x, bounds.width - 220),
            top: Math.min(rect.y + rect.height + 8, bounds.height - 40)
          }}
        >
          <span className="text-zinc-400">
            {Math.round(rect.width)}×{Math.round(rect.height)}
          </span>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="rounded bg-cyan-600 px-2 py-0.5 font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            Capture
          </button>
          <button
            type="button"
            onClick={cancel}
            className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
