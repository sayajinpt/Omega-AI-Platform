/**
 * Tiny i18n helper. Reads the active locale from localStorage (set by Settings),
 * looks up keys in the bundled dictionaries, falls back to English.
 */
import en from './locales/en'
import es from './locales/es'
import ptBR from './locales/pt-BR'
import zhCN from './locales/zh-CN'
import ja from './locales/ja'
import fr from './locales/fr'

export type LocaleId = 'en' | 'es' | 'pt-BR' | 'zh-CN' | 'ja' | 'fr'

const dicts: Record<LocaleId, Record<string, string>> = {
  en,
  es,
  'pt-BR': ptBR,
  'zh-CN': zhCN,
  ja,
  fr
}

const LOCALE_KEY = 'omega.locale'

export function getLocale(): LocaleId {
  const stored = localStorage.getItem(LOCALE_KEY) as LocaleId | null
  return stored && stored in dicts ? stored : 'en'
}

export function setLocale(id: LocaleId): void {
  localStorage.setItem(LOCALE_KEY, id)
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = getLocale()
  const dict = dicts[locale] ?? en
  let str = dict[key] ?? en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, String(v))
  }
  return str
}

export const LOCALES: Array<{ id: LocaleId; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'pt-BR', label: 'Português (BR)' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'ja', label: '日本語' },
  { id: 'fr', label: 'Français' }
]
