import { engineClient } from './engine'
import type { HfGatedDialogState } from '../components/HfGatedModelDialog'
import { hintFromAccess, isLikelyHfGatedMessage, messageForGatedRepo } from './hf-gated-types'

export async function probeHfRepoBeforeDownload(repo: string): Promise<HfGatedDialogState | null> {
  try {
    const access = await engineClient.models.checkHfAccess(repo)
    if (access.ok || !access.gated) return null
    const hint = hintFromAccess(access)
    const { opened } = await engineClient.models.openHfRepo(repo)
    return {
      repo,
      hint,
      pageUrl: access.pageUrl,
      openedBrowser: opened,
      message: messageForGatedRepo(repo, hint, opened, access.pageUrl)
    }
  } catch {
    return null
  }
}

export function isHubRepoNotFoundMessage(msg: string): boolean {
  return /does not exist \(404\)|not found \(404\)|catalog entry may be outdated/i.test(msg)
}

export function gatedDialogFromError(repo: string, err: unknown): HfGatedDialogState | null {
  const message = err instanceof Error ? err.message : String(err)
  if (isHubRepoNotFoundMessage(message)) return null
  if (!isLikelyHfGatedMessage(message)) return null
  const openedBrowser = /opened the model page|opened in your browser/i.test(message)
  let hint: HfGatedDialogState['hint'] = 'add_token'
  if (/accept the license|403/i.test(message)) hint = 'accept_license'
  else if (/rejected your token|expired/i.test(message)) hint = 'refresh_token'
  return {
    repo,
    message,
    pageUrl: `https://huggingface.co/${repo}`,
    hint,
    openedBrowser
  }
}
