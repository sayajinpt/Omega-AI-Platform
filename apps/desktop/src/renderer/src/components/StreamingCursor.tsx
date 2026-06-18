/** Blinking caret shown while the active assistant message is streaming. */
export function StreamingCursor() {
  return (
    <span
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-indigo-400"
      aria-hidden
    />
  )
}
