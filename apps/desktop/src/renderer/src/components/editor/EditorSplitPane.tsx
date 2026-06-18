import { useCallback, useEffect, useRef, type ReactNode } from 'react'

/** Horizontal split with draggable divider (Notepad++-style dual view). */
export function EditorSplitPane({
  enabled,
  ratio,
  onRatioChange,
  left,
  right
}: {
  enabled: boolean
  ratio: number
  onRatioChange: (ratio: number) => void
  left: ReactNode
  right: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startRatio: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startRatio: ratio }
    },
    [ratio]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const width = hostRef.current?.clientWidth ?? window.innerWidth
      const delta = (e.clientX - d.startX) / width
      onRatioChange(Math.min(0.85, Math.max(0.15, d.startRatio + delta)))
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [onRatioChange])

  if (!enabled) {
    return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{left}</div>
  }

  const leftPct = `${Math.round(ratio * 100)}%`

  return (
    <div ref={hostRef} className="flex min-h-0 flex-1 overflow-hidden" data-split-host>
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ width: leftPct }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        className="w-1 shrink-0 cursor-col-resize bg-zinc-800 hover:bg-indigo-600/60"
        onPointerDown={onPointerDown}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{right}</div>
    </div>
  )
}
