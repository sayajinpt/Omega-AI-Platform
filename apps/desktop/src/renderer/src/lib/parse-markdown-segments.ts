export type MarkdownSegment =
  | { type: 'prose'; text: string }
  | { type: 'code'; lang: string; code: string }

/** Split assistant text into prose vs fenced code blocks for dedicated code bubbles. */
export function isAgentToolCodeSegment(lang: string, code: string): boolean {
  const l = lang.trim().toLowerCase()
  if (l === 'tool' || l === 'tools') return true
  if ((l === 'json' || l === '') && /"name"\s*:\s*"/.test(code) && /"args"\s*:/.test(code)) {
    return true
  }
  return false
}

export function parseMarkdownCodeSegments(text: string): MarkdownSegment[] {
  if (!text.includes('```')) {
    return [{ type: 'prose', text }]
  }
  const segments: MarkdownSegment[] = []
  const re = /```([^\n`]*)\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const prose = text.slice(last, m.index)
      if (prose.trim()) segments.push({ type: 'prose', text: prose })
    }
    const lang = (m[1] ?? '').trim() || 'text'
    const code = m[2] ?? ''
    if (!isAgentToolCodeSegment(lang, code)) {
      segments.push({ type: 'code', lang, code })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) {
    const tail = text.slice(last)
    const openFence = tail.match(/^```([^\n`]*)\n?([\s\S]*)$/)
    if (openFence) {
      const lang = (openFence[1] ?? '').trim() || 'text'
      const code = openFence[2] ?? ''
      if (!isAgentToolCodeSegment(lang, code)) {
        segments.push({ type: 'code', lang, code })
      }
    } else if (tail.trim()) {
      segments.push({ type: 'prose', text: tail })
    }
  }
  return segments.length ? segments : [{ type: 'prose', text }]
}

/** Rebuild message text after editing one fenced code block by index. */
export function replaceCodeFenceInMessage(
  content: string,
  blockIndex: number,
  newCode: string,
  lang: string
): string {
  const segments = parseMarkdownCodeSegments(content)
  let codeIdx = 0
  return segments
    .map((seg) => {
      if (seg.type === 'code') {
        const current = codeIdx
        codeIdx += 1
        if (current === blockIndex) {
          return `\`\`\`${lang}\n${newCode}\n\`\`\``
        }
        return `\`\`\`${seg.lang}\n${seg.code}\n\`\`\``
      }
      return seg.text
    })
    .join('')
}
