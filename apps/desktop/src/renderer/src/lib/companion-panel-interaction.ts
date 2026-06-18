import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { AVATAR_SQUARE, clampAvatarScale } from '../../../shared/avatar-layout'

export type PanelPos = { x: number; y: number }

export function viewportSize(): { w: number; h: number } {
  const vv = window.visualViewport
  return {
    w: vv?.width ?? window.innerWidth,
    h: vv?.height ?? window.innerHeight
  }
}

export function clampPanelPos(p: PanelPos, panelW: number, panelH: number): PanelPos {
  const margin = 8
  const { w: vw, h: vh } = viewportSize()
  return {
    x: Math.max(margin, Math.min(vw - panelW - margin, p.x)),
    y: Math.max(margin, Math.min(vh - panelH - margin, p.y))
  }
}

/** Symmetric scale delta from SE-corner drag (avoids max(dx,dy) jumps). */
export function scaleDeltaFromPointer(dx: number, dy: number): number {
  return (dx + dy) / (2 * AVATAR_SQUARE)
}

export function useCompanionInteractionGuard(
  overlay: boolean,
  panelW: number,
  panelH: number,
  scale: number,
  pos: PanelPos,
  setPos: (p: PanelPos | ((prev: PanelPos) => PanelPos)) => void,
  measurePanel: () => { w: number; h: number }
) {
  const modeRef = useRef<'none' | 'drag' | 'resize'>('none')

  const clampToViewport = useCallback(
    (p: PanelPos): PanelPos => {
      const { w, h } = measurePanel()
      return clampPanelPos(p, w, h)
    },
    [measurePanel]
  )

  const finishInteraction = useCallback(() => {
    modeRef.current = 'none'
    document.body.style.userSelect = ''
    if (!overlay) setPos((p) => clampToViewport(p))
  }, [overlay, setPos, clampToViewport])

  useLayoutEffect(() => {
    if (overlay || modeRef.current !== 'none') return
    setPos((p) => clampToViewport(p))
  }, [overlay, scale, panelW, panelH, clampToViewport, setPos])

  useEffect(() => {
    if (overlay) return
    const onResize = (): void => {
      if (modeRef.current !== 'none') return
      setPos((p) => clampToViewport(p))
    }
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [overlay, clampToViewport, setPos])

  return { modeRef, clampToViewport, finishInteraction }
}

export function useCompanionPanelDrag(options: {
  overlay: boolean
  pos: PanelPos
  setPos: (p: PanelPos | ((prev: PanelPos) => PanelPos)) => void
  scale: number
  modeRef: { current: 'none' | 'drag' | 'resize' }
  clampToViewport: (p: PanelPos) => PanelPos
  finishInteraction: () => void
  syncOverlayLayout: (scale: number, screenPos?: { x: number; y: number }) => void
  overlayPosRef: { current: { x: number; y: number } }
}): (e: React.PointerEvent) => void {
  const {
    overlay,
    pos,
    setPos,
    scale,
    modeRef,
    clampToViewport,
    finishInteraction,
    syncOverlayLayout,
    overlayPosRef
  } = options

  return useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const header = e.currentTarget as HTMLElement
      if ((e.target as HTMLElement).closest('button, input, label, a')) return

      e.preventDefault()
      modeRef.current = 'drag'
      document.body.style.userSelect = 'none'
      header.setPointerCapture(e.pointerId)

      const origin = overlay
        ? { ox: e.screenX, oy: e.screenY, px: overlayPosRef.current.x, py: overlayPosRef.current.y }
        : { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y }

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        if (overlay) {
          const x = origin.px + ev.screenX - origin.ox
          const y = origin.py + ev.screenY - origin.oy
          overlayPosRef.current = { x, y }
          syncOverlayLayout(scale, { x, y })
        } else {
          setPos({
            x: origin.px + ev.clientX - origin.ox,
            y: origin.py + ev.clientY - origin.oy
          })
        }
      }

      const onEnd = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId && ev.type !== 'lostpointercapture') return
        try {
          header.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
        header.removeEventListener('pointermove', onMove)
        header.removeEventListener('pointerup', onEnd)
        header.removeEventListener('pointercancel', onEnd)
        header.removeEventListener('lostpointercapture', onEnd)
        if (!overlay) {
          setPos((p) => clampToViewport(p))
        }
        finishInteraction()
      }

      header.addEventListener('pointermove', onMove)
      header.addEventListener('pointerup', onEnd)
      header.addEventListener('pointercancel', onEnd)
      header.addEventListener('lostpointercapture', onEnd)
    },
    [
      overlay,
      pos,
      setPos,
      scale,
      modeRef,
      clampToViewport,
      finishInteraction,
      syncOverlayLayout,
      overlayPosRef
    ]
  )
}

export function useCompanionPanelResize(options: {
  overlay: boolean
  scale: number
  setScale: (s: number) => void
  persistScale: (s: number) => void
  modeRef: { current: 'none' | 'drag' | 'resize' }
  finishInteraction: () => void
  syncOverlayLayout: (scale: number) => void
}): (e: React.PointerEvent) => void {
  const { overlay, scale, setScale, persistScale, modeRef, finishInteraction, syncOverlayLayout } =
    options
  const overlaySyncRaf = useRef<number | null>(null)

  const scheduleOverlayScale = useCallback(
    (next: number) => {
      if (!overlay) return
      if (overlaySyncRaf.current != null) cancelAnimationFrame(overlaySyncRaf.current)
      overlaySyncRaf.current = requestAnimationFrame(() => {
        syncOverlayLayout(next)
        overlaySyncRaf.current = null
      })
    },
    [overlay, syncOverlayLayout]
  )

  useEffect(
    () => () => {
      if (overlaySyncRaf.current != null) cancelAnimationFrame(overlaySyncRaf.current)
    },
    []
  )

  return useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()

      const handle = e.currentTarget as HTMLElement
      modeRef.current = 'resize'
      document.body.style.userSelect = 'none'
      handle.setPointerCapture(e.pointerId)

      const startX = e.clientX
      const startY = e.clientY
      const startScale = scale

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        const next = clampAvatarScale(startScale + scaleDeltaFromPointer(ev.clientX - startX, ev.clientY - startY))
        setScale(next)
        if (overlay) scheduleOverlayScale(next)
      }

      const onEnd = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId && ev.type !== 'lostpointercapture') return
        try {
          handle.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
        handle.removeEventListener('lostpointercapture', onEnd)
        const next = clampAvatarScale(
          startScale + scaleDeltaFromPointer(ev.clientX - startX, ev.clientY - startY)
        )
        persistScale(next)
        finishInteraction()
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
      handle.addEventListener('lostpointercapture', onEnd)
    },
    [overlay, scale, setScale, persistScale, modeRef, finishInteraction, scheduleOverlayScale]
  )
}
