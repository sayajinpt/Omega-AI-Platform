/**
 * Parse user paste: full HF URL, hf.co short link, or owner/repo.
 */
export function parseHfRepoInput(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null

  const urlMatch = text.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^?\s#]+)/i
  )
  if (urlMatch?.[1]) {
    const path = urlMatch[1].replace(/^models\//i, '').replace(/\/+$/, '')
    const parts = path.split('/').filter(Boolean)
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
    return null
  }

  const slash = text.replace(/^@/, '').replace(/\/+$/, '')
  if (/^[\w.-]+\/[\w.-]+$/i.test(slash)) return slash

  return null
}

export function hfRepoPageUrl(repo: string): string {
  return `https://huggingface.co/${repo.trim().replace(/^\/+|\/+$/g, '')}`
}
