import type { CompanionAnimationStyle } from '../../../shared/companion-animation-style'

export type { CompanionAnimationStyle }

export const COMPANION_ANIMATION_STYLE_KEY = 'omega.companion.animationStyle'
export const COMPANION_ANIMATION_STYLE_EVENT = 'omega:companion-animation-style'

export const COMPANION_ANIMATION_STYLES: Array<{
  id: CompanionAnimationStyle
  label: string
  description: string
}> = [
  {
    id: 'neural_mesh',
    label: 'Neural mesh',
    description: 'Classic layered graph — GPU bands, load wave, pool slots'
  },
  {
    id: 'matrix_layers',
    label: 'Matrix pages',
    description: 'Stacked 2D matrix sheets in depth — scan lines and cell activations'
  },
  {
    id: 'spider_web',
    label: 'Spider web',
    description: 'Hub-and-spoke web with ring chords — pulses along strands'
  }
]

const VALID_STYLES: CompanionAnimationStyle[] = ['neural_mesh', 'matrix_layers', 'spider_web']

function migrateLegacyStyle(raw: string | null): CompanionAnimationStyle | null {
  if (!raw) return null
  if (raw === 'kv_orbit' || raw === 'token_flow' || raw === 'neural_lattice') return 'matrix_layers'
  if (raw === 'neural_helix') return 'spider_web'
  if (VALID_STYLES.includes(raw as CompanionAnimationStyle)) return raw as CompanionAnimationStyle
  return null
}

export function getCompanionAnimationStyle(): CompanionAnimationStyle {
  try {
    const migrated = migrateLegacyStyle(localStorage.getItem(COMPANION_ANIMATION_STYLE_KEY))
    if (migrated) return migrated
  } catch {
    /* ignore */
  }
  return 'neural_mesh'
}

export function setCompanionAnimationStyle(style: CompanionAnimationStyle): void {
  try {
    localStorage.setItem(COMPANION_ANIMATION_STYLE_KEY, style)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent(COMPANION_ANIMATION_STYLE_EVENT, { detail: { style } })
  )
}

export function onCompanionAnimationStyle(
  cb: (style: CompanionAnimationStyle) => void
): () => void {
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ style: CompanionAnimationStyle }>).detail
    if (d?.style) cb(d.style)
  }
  window.addEventListener(COMPANION_ANIMATION_STYLE_EVENT, fn)
  return () => window.removeEventListener(COMPANION_ANIMATION_STYLE_EVENT, fn)
}

export function isCompanionAnimationStyle(v: string | undefined): v is CompanionAnimationStyle {
  return Boolean(v && VALID_STYLES.includes(v as CompanionAnimationStyle))
}
