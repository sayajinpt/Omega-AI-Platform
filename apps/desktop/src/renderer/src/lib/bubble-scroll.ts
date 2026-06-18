import type { WheelEvent as ReactWheelEvent } from 'react'

/** Keep mouse-wheel scrolling inside a bubble until top/bottom, then pass to the chat list. */
export function handleBubbleWheel(e: ReactWheelEvent<HTMLDivElement>): void {
  const el = e.currentTarget
  if (el.scrollHeight <= el.clientHeight + 1) return
  const atTop = el.scrollTop <= 0
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
  if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
    e.stopPropagation()
  }
}
