import { useCallback, useEffect, useRef, type ReactNode } from 'react'

type Side = 'left' | 'right'

export function ResizablePanel({
  side,
  width,
  hidden,
  minWidth = 160,
  maxWidth = 480,
  onWidthChange,
  onHiddenChange,
  onResizeEnd,
  className = '',
  children
}: {
  side: Side
  width: number
  hidden: boolean
  minWidth?: number
  maxWidth?: number
  onWidthChange: (w: number) => void
  onHiddenChange?: (hidden: boolean) => void
  onResizeEnd?: () => void
  className?: string
  children: ReactNode
}) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (hidden) return
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startW: width }
    },
    [hidden, width]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!dragRef.current) return
      const delta = e.clientX - dragRef.current.startX
      const next =
        side === 'left'
          ? dragRef.current.startW + delta
          : dragRef.current.startW - delta
      onWidthChange(Math.min(maxWidth, Math.max(minWidth, next)))
    }
    const onUp = (e: PointerEvent): void => {
      if (dragRef.current) onResizeEnd?.()
      dragRef.current = null
      document.body.style.userSelect = ''
      try {
        if (e.target instanceof HTMLElement && e.target.hasPointerCapture(e.pointerId)) {
          e.target.releasePointerCapture(e.pointerId)
        }
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.userSelect = ''
    }
  }, [side, minWidth, maxWidth, onWidthChange, onResizeEnd])

  if (hidden) {
    return (
      <div
        className={`flex shrink-0 flex-col border-zinc-800 bg-zinc-900/40 ${side === 'left' ? 'border-r' : 'border-l'} ${className}`}
      >
        <button
          type="button"
          title="Show panel"
          onClick={() => onHiddenChange?.(false)}
          className="flex h-full min-h-[2rem] w-7 items-center justify-center text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          {side === 'left' ? '▶' : '◀'}
        </button>
      </div>
    )
  }

  return (
    <div
      className={`relative flex shrink-0 flex-col ${side === 'left' ? 'border-r' : 'border-l'} border-zinc-800 bg-zinc-900/40 ${className}`}
      style={{ width }}
    >
      {onHiddenChange && (
        <button
          type="button"
          title="Hide panel"
          onClick={() => onHiddenChange(true)}
          className={`absolute top-1 z-10 rounded px-1 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 ${
            side === 'left' ? 'right-1' : 'left-1'
          }`}
        >
          {side === 'left' ? '◀' : '▶'}
        </button>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        className={`absolute top-0 z-20 h-full w-1.5 cursor-col-resize touch-none hover:bg-indigo-500/40 ${
          side === 'left' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'
        }`}
      />
    </div>
  )
}
