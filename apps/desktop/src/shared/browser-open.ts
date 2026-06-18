/** Dispatched when any feature should open a URL in the native Browser tab. */
export const OMEGA_BROWSER_OPEN = 'omega:browser:open'

export type OmegaBrowserOpenDetail = { url: string }

/** Add https:// when the user omits a scheme (e.g. google.com). */
export function normalizeBrowserUrl(raw: string): string {
  const target = raw.trim()
  if (!target) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return target
  if (target.startsWith('//')) return `https:${target}`
  return `https://${target}`
}

export function hfRepoPageUrl(repo: string): string {
  const trimmed = repo.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return `https://huggingface.co/${trimmed}`
}

/** Switch to Browser tab (via App listener) and queue navigation once the viewport is placed. */
export function requestOmegaBrowser(url: string): void {
  if (typeof window === 'undefined') return
  const target = normalizeBrowserUrl(url)
  if (!target) return
  window.dispatchEvent(
    new CustomEvent<OmegaBrowserOpenDetail>(OMEGA_BROWSER_OPEN, { detail: { url: target } })
  )
}
