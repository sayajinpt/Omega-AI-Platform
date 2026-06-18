/** Mirrors main-process HfAccessHint for renderer UI. */
export type HfAccessHint = 'accept_license' | 'add_token' | 'refresh_token'

export type HfRepoAccessResult = {
  ok: boolean
  status: number
  hasToken: boolean
  pageUrl: string
  gated: boolean
  hint: HfAccessHint | null
}

export function hintFromAccess(access: HfRepoAccessResult): HfAccessHint {
  if (access.hint) return access.hint
  if (access.status === 403) return 'accept_license'
  if (access.hasToken) return 'refresh_token'
  return 'add_token'
}

export function messageForGatedRepo(
  repo: string,
  hint: HfAccessHint,
  openedBrowser: boolean,
  pageUrl: string
): string {
  const opened = openedBrowser
    ? 'We opened the model page in your browser.'
    : `Open: ${pageUrl}`
  if (hint === 'accept_license') {
    return `${opened} Sign in on Hugging Face and accept the license for "${repo}", then retry.`
  }
  if (hint === 'refresh_token') {
    return `${opened} Accept the license if needed, then update your HuggingFace token in Settings and retry.`
  }
  return `${opened} Accept the license, add a read token under Settings → General → HuggingFace token, then retry.`
}

export function isLikelyHfGatedMessage(msg: string): boolean {
  return /401|403|gated|authentication|hugging\s*face\s*token|accept the license/i.test(msg)
}
