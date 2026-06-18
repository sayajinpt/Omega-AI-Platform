import type { OmegaConfig } from '@omega/sdk'
import { DARK_THEME, LIGHT_THEME, mergeThemeColors, resolveUiThemeMode, themeCssVariables } from '../../../shared/theme'

export function applyThemeFromConfig(config: OmegaConfig): () => void {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const mode = config.uiTheme ?? 'dark'

  let resolved: 'dark' | 'light'
  if (mode === 'custom') {
    resolved = config.themeBase === 'light' ? 'light' : 'dark'
  } else {
    resolved = resolveUiThemeMode(mode, prefersDark)
  }

  const base = resolved === 'light' ? LIGHT_THEME : DARK_THEME
  const colors = mergeThemeColors(base, mode === 'custom' ? config.themeColors : undefined)

  root.dataset.theme = resolved
  root.dataset.themeMode = mode
  const vars = themeCssVariables(colors)
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }

  if (mode !== 'system') {
    return () => undefined
  }

  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => applyThemeFromConfig({ ...config, uiTheme: 'system' })
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
