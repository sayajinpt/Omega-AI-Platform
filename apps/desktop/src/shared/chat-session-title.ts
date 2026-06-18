/** Placeholder titles until the first user message sets a readable name. */
const PLACEHOLDER_TITLES = new Set(['', 'new chat', 'untitled', 'untitled chat'])

export function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title.trim().toLowerCase())
}

/** Short sidebar label from the user's first message (skips attachment-only lines). */
export function deriveSessionTitle(text: string): string {
  const lines = text.trim().split('\n')
  const line =
    lines.find((l) => {
      const t = l.trim()
      return t.length > 0 && !/^\[(Image|File|Video|Audio):/i.test(t)
    }) ?? lines[0] ?? ''
  const one = line.trim().replace(/\s+/g, ' ')
  if (!one) return 'New chat'
  return one.length > 72 ? `${one.slice(0, 72)}…` : one
}
