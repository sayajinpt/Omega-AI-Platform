import type {
  CompanionCustomColorKey,
  CompanionCustomColors
} from '../../../shared/companion-color-scheme'
import {
  buildCompanionColorPalette,
  COMPANION_COLOR_PALETTES,
  DEFAULT_COMPANION_CUSTOM_COLORS,
  mergeCompanionCustomColors,
  normalizeHexColor,
  paletteToCustomColors,
  type CompanionColorPalette,
  type CompanionColorScheme
} from '../../../shared/companion-color-scheme'

export type { CompanionCustomColors, CompanionCustomColorKey, CompanionColorPalette }
export {
  buildCompanionColorPalette,
  COMPANION_COLOR_FIELD_GROUPS,
  DEFAULT_COMPANION_CUSTOM_COLORS,
  normalizeHexColor
} from '../../../shared/companion-color-scheme'

export const COMPANION_CUSTOM_COLORS_KEY = 'omega.companion.customColors'
/** @deprecated Migrated into custom colors on first read. */
export const COMPANION_COLOR_SCHEME_KEY = 'omega.companion.colorScheme'
export const COMPANION_CUSTOM_COLORS_EVENT = 'omega:companion-custom-colors'

const LEGACY_SCHEMES: CompanionColorScheme[] = ['omega', 'aurora', 'ember']

function normalizeStored(raw: unknown): CompanionCustomColors | null {
  if (!raw || typeof raw !== 'object') return null
  const partial: Partial<CompanionCustomColors> = {}
  for (const key of Object.keys(DEFAULT_COMPANION_CUSTOM_COLORS) as CompanionCustomColorKey[]) {
    const v = (raw as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) partial[key] = v.trim()
  }
  if (Object.keys(partial).length === 0) return null
  return mergeCompanionCustomColors(partial)
}

function migrateLegacyScheme(): CompanionCustomColors | null {
  try {
    const legacy = localStorage.getItem(COMPANION_COLOR_SCHEME_KEY)
    if (!legacy || !LEGACY_SCHEMES.includes(legacy as CompanionColorScheme)) return null
    return paletteToCustomColors(COMPANION_COLOR_PALETTES[legacy as CompanionColorScheme])
  } catch {
    return null
  }
}

export function getCompanionCustomColors(): CompanionCustomColors {
  try {
    const raw = localStorage.getItem(COMPANION_CUSTOM_COLORS_KEY)
    if (raw) {
      const parsed = normalizeStored(JSON.parse(raw) as unknown)
      if (parsed) return parsed
    }
  } catch {
    /* ignore */
  }
  const migrated = migrateLegacyScheme()
  if (migrated) {
    setCompanionCustomColors(migrated, { persistOnly: true })
    return migrated
  }
  return { ...DEFAULT_COMPANION_CUSTOM_COLORS }
}

export function getActiveCompanionColorPalette(): CompanionColorPalette {
  return buildCompanionColorPalette(getCompanionCustomColors())
}

export function setCompanionCustomColors(
  colors: CompanionCustomColors,
  opts?: { persistOnly?: boolean }
): void {
  const merged = mergeCompanionCustomColors(colors)
  try {
    localStorage.setItem(COMPANION_CUSTOM_COLORS_KEY, JSON.stringify(merged))
  } catch {
    /* ignore */
  }
  if (!opts?.persistOnly) {
    window.dispatchEvent(
      new CustomEvent(COMPANION_CUSTOM_COLORS_EVENT, { detail: { colors: merged } })
    )
  }
}

export function setCompanionCustomColor(key: CompanionCustomColorKey, hex: string): void {
  const next = { ...getCompanionCustomColors(), [key]: normalizeHexColor(hex, DEFAULT_COMPANION_CUSTOM_COLORS[key]) }
  setCompanionCustomColors(next)
}

export function resetCompanionCustomColors(): void {
  setCompanionCustomColors({ ...DEFAULT_COMPANION_CUSTOM_COLORS })
}

export function onCompanionCustomColors(
  cb: (colors: CompanionCustomColors) => void
): () => void {
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ colors: CompanionCustomColors }>).detail
    if (d?.colors) cb(d.colors)
  }
  window.addEventListener(COMPANION_CUSTOM_COLORS_EVENT, fn)
  return () => window.removeEventListener(COMPANION_CUSTOM_COLORS_EVENT, fn)
}
