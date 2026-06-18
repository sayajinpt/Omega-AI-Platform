import {
  hfRepoPageUrl,
  OMEGA_BROWSER_OPEN,
  requestOmegaBrowser,
  type OmegaBrowserOpenDetail
} from '../../../shared/browser-open'
import { engineClient } from './engine'

export { OMEGA_BROWSER_OPEN, type OmegaBrowserOpenDetail, requestOmegaBrowser }

/** Open a Hugging Face repo page in the Omega native browser. */
export async function openHfRepoInBrowser(
  repo: string
): Promise<{ opened: boolean; pageUrl: string }> {
  const trimmed = repo.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  const pageUrl = hfRepoPageUrl(trimmed)
  requestOmegaBrowser(pageUrl)
  try {
    const result = await engineClient.models.openHfRepo(trimmed)
    return { opened: result.opened || true, pageUrl: result.pageUrl || pageUrl }
  } catch {
    return { opened: true, pageUrl }
  }
}
