import { useEffect, useMemo, useState } from 'react'
import type { OmegaConfig, OmegaThemeColors, UiThemeMode } from '@omega/sdk'
import { BRAND_NAME } from '../../../shared/brand'
import { DARK_THEME, LIGHT_THEME } from '../../../shared/theme'
import { applyThemeFromConfig } from '../lib/apply-theme'

const COLOR_FIELDS: { key: keyof OmegaThemeColors; label: string; hint?: string }[] = [
  { key: 'background', label: 'App background' },
  { key: 'surface', label: 'Panels & cards' },
  { key: 'surfaceElevated', label: 'Elevated surfaces' },
  { key: 'border', label: 'Borders' },
  { key: 'text', label: 'Primary text' },
  { key: 'textMuted', label: 'Secondary text' },
  { key: 'textHeading', label: 'Headings' },
  { key: 'accent', label: 'Accent & links' },
  { key: 'accentMuted', label: 'Accent (muted)' },
  { key: 'chatUserBg', label: 'Chat — your messages (bg)' },
  { key: 'chatUserText', label: 'Chat — your messages (text)' },
  { key: 'chatAssistantBg', label: 'Chat — assistant (bg)' },
  { key: 'chatAssistantText', label: 'Chat — assistant (text)' },
  { key: 'value', label: 'Values & metrics' },
  { key: 'codeBg', label: 'Code blocks' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'error', label: 'Error' }
]

function ColorRow({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
}) {
  const picker =
    value.startsWith('#') && value.length >= 7 ? value.slice(0, 7) : '#6366f1'
  return (
    <label className="grid grid-cols-[1fr_auto] items-center gap-2 text-xs">
      <span className="text-[var(--omega-text-muted)]">
        {label}
        {hint ? <span className="ml-1 text-[10px] opacity-70">({hint})</span> : null}
      </span>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={picker}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border border-[var(--omega-border)] bg-transparent"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="omega-input w-28 font-mono text-[11px]"
        />
      </span>
    </label>
  )
}

export function ThemeSettings({
  draft,
  setDraft
}: {
  draft: OmegaConfig
  setDraft: (c: OmegaConfig) => void
}) {
  const mode = (draft.uiTheme ?? 'dark') as UiThemeMode
  const [showCustom, setShowCustom] = useState(mode === 'custom')

  useEffect(() => {
    const cleanup = applyThemeFromConfig(draft)
    return () => cleanup?.()
  }, [draft.uiTheme, draft.themeColors, draft.themeBase])

  const base = useMemo(
    () => (draft.themeBase === 'light' ? LIGHT_THEME : DARK_THEME),
    [draft.themeBase]
  )

  const colors = useMemo(
    () => ({ ...base, ...(draft.themeColors ?? {}) }),
    [base, draft.themeColors]
  )

  const setMode = (uiTheme: UiThemeMode) => {
    setShowCustom(uiTheme === 'custom')
    setDraft({
      ...draft,
      uiTheme,
      ...(uiTheme === 'custom' && !draft.themeColors
        ? { themeColors: { ...base }, themeBase: draft.themeBase ?? 'dark' }
        : {})
    })
  }

  const patchColor = (key: keyof OmegaThemeColors, value: string) => {
    setDraft({
      ...draft,
      uiTheme: 'custom',
      themeColors: { ...colors, [key]: value }
    })
  }

  const resetCustom = () => {
    const b = draft.themeBase === 'light' ? LIGHT_THEME : DARK_THEME
    setDraft({ ...draft, uiTheme: 'custom', themeColors: { ...b } })
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[var(--omega-text-muted)]">
        Personalize {BRAND_NAME} appearance. Custom mode lets you tune chat bubbles, text, accents, and
        semantic colors.
      </p>

      <label className="block">
        <span className="text-[var(--omega-text-muted)]">Theme mode</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as UiThemeMode)}
          className="omega-input mt-1 w-full max-w-xs"
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">System</option>
          <option value="custom">Custom colors</option>
        </select>
      </label>

      {mode === 'custom' && (
        <>
          <label className="block">
            <span className="text-[var(--omega-text-muted)]">Custom palette based on</span>
            <select
              value={draft.themeBase ?? 'dark'}
              onChange={(e) => {
                const themeBase = e.target.value as 'dark' | 'light'
                const b = themeBase === 'light' ? LIGHT_THEME : DARK_THEME
                setDraft({ ...draft, themeBase, themeColors: { ...b, ...draft.themeColors } })
              }}
              className="omega-input mt-1 w-full max-w-xs"
            >
              <option value="dark">Dark preset</option>
              <option value="light">Light preset</option>
            </select>
          </label>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="omega-btn-secondary text-xs" onClick={() => setShowCustom((s) => !s)}>
              {showCustom ? 'Hide' : 'Show'} color editor
            </button>
            <button type="button" className="omega-btn-secondary text-xs" onClick={resetCustom}>
              Reset to preset
            </button>
          </div>

          {showCustom && (
            <div className="grid gap-2 rounded-lg border border-[var(--omega-border)] bg-[var(--omega-surface)] p-3">
              {COLOR_FIELDS.map((f) => (
                <ColorRow
                  key={f.key}
                  label={f.label}
                  hint={f.hint}
                  value={colors[f.key] ?? base[f.key]}
                  onChange={(v) => patchColor(f.key, v)}
                />
              ))}
            </div>
          )}

          <div className="rounded-lg border border-[var(--omega-border)] p-3">
            <p className="mb-2 text-xs text-[var(--omega-text-muted)]">Preview</p>
            <div className="space-y-2">
              <div
                className="ml-auto max-w-[85%] rounded-xl px-3 py-2 text-sm"
                style={{
                  background: colors.chatUserBg,
                  color: colors.chatUserText
                }}
              >
                User message sample
              </div>
              <div
                className="max-w-[85%] rounded-xl px-3 py-2 text-sm"
                style={{
                  background: colors.chatAssistantBg,
                  color: colors.chatAssistantText
                }}
              >
                Assistant reply sample
              </div>
              <p className="text-sm text-[var(--omega-text)]">
                Body text — <span style={{ color: colors.value }}>value: 42 tokens</span>
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

