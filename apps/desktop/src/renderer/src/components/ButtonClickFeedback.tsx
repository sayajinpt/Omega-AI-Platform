import { useEffect } from 'react'

const CLICKABLE =
  'button:not(:disabled), input[type="button"]:not(:disabled), input[type="submit"]:not(:disabled), [data-omega-clickable]:not([aria-disabled="true"])'

/**
 * Pointer ripple on interactive controls app-wide (no per-button wiring).
 */
export function ButtonClickFeedback() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const el = (e.target as HTMLElement | null)?.closest(CLICKABLE)
      if (!el || !(el instanceof HTMLElement)) return

      const rect = el.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height, 24) * 1.35
      const x = e.clientX - rect.left - size / 2
      const y = e.clientY - rect.top - size / 2

      const ripple = document.createElement('span')
      ripple.className = 'omega-click-ripple'
      ripple.style.width = `${size}px`
      ripple.style.height = `${size}px`
      ripple.style.left = `${x}px`
      ripple.style.top = `${y}px`

      el.classList.add('omega-btn-pressing')
      el.appendChild(ripple)
      const done = () => {
        ripple.remove()
        el.classList.remove('omega-btn-pressing')
      }
      ripple.addEventListener('animationend', done, { once: true })
      window.setTimeout(done, 500)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  return null
}
