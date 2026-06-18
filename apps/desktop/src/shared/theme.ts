import type { OmegaThemeColors, UiThemeMode } from '@omega/sdk'

export const DARK_THEME: Required<OmegaThemeColors> = {
  background: '#09090b',
  surface: '#18181b',
  surfaceElevated: '#27272a',
  border: '#3f3f46',
  text: '#fafafa',
  textMuted: '#a1a1aa',
  textHeading: '#e4e4e7',
  accent: '#6366f1',
  accentMuted: '#4f46e5',
  chatUserBg: 'rgba(99, 102, 241, 0.22)',
  chatUserText: '#e0e7ff',
  chatAssistantBg: '#18181b',
  chatAssistantText: '#f4f4f5',
  value: '#34d399',
  codeBg: '#27272a',
  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171'
}

export const LIGHT_THEME: Required<OmegaThemeColors> = {
  background: '#f4f4f5',
  surface: '#ffffff',
  surfaceElevated: '#e4e4e7',
  border: '#d4d4d8',
  text: '#18181b',
  textMuted: '#52525b',
  textHeading: '#09090b',
  accent: '#4f46e5',
  accentMuted: '#6366f1',
  chatUserBg: 'rgba(79, 70, 229, 0.12)',
  chatUserText: '#312e81',
  chatAssistantBg: '#ffffff',
  chatAssistantText: '#18181b',
  value: '#059669',
  codeBg: '#e4e4e7',
  success: '#059669',
  warning: '#d97706',
  error: '#dc2626'
}

export function mergeThemeColors(
  base: Required<OmegaThemeColors>,
  overrides?: OmegaThemeColors
): Required<OmegaThemeColors> {
  if (!overrides) return { ...base }
  return { ...base, ...overrides }
}

export function resolveUiThemeMode(
  mode: UiThemeMode | undefined,
  prefersDark: boolean
): 'dark' | 'light' {
  const pick = mode ?? 'dark'
  if (pick === 'system') return prefersDark ? 'dark' : 'light'
  if (pick === 'custom') return prefersDark ? 'dark' : 'light'
  return pick
}

export function themeCssVariables(colors: Required<OmegaThemeColors>): Record<string, string> {
  return {
    '--omega-bg': colors.background,
    '--omega-surface': colors.surface,
    '--omega-surface-elevated': colors.surfaceElevated,
    '--omega-border': colors.border,
    '--omega-text': colors.text,
    '--omega-text-muted': colors.textMuted,
    '--omega-text-heading': colors.textHeading,
    '--omega-accent': colors.accent,
    '--omega-accent-muted': colors.accentMuted,
    '--omega-chat-user-bg': colors.chatUserBg,
    '--omega-chat-user-text': colors.chatUserText,
    '--omega-chat-assistant-bg': colors.chatAssistantBg,
    '--omega-chat-assistant-text': colors.chatAssistantText,
    '--omega-value': colors.value,
    '--omega-code-bg': colors.codeBg,
    '--omega-success': colors.success,
    '--omega-warning': colors.warning,
    '--omega-error': colors.error
  }
}
