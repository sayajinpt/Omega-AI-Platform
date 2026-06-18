/** Result of splitting model chain-of-thought from the visible assistant reply. */
export type SplitThinkingResult = {
  thinking: string
  content: string
  /** Thought block started but closing tag not seen yet (streaming). */
  thinkingOpen: boolean
}

/** Paired thinking delimiters used by local HF / GGUF chat templates (model-agnostic). */
export type ThinkingTagPair = {
  /** Short label for tests / debugging only. */
  id: string
  open: string
  close: string | null
}

/**
 * Tag pairs observed across thinking-capable templates (llama.cpp chat + common HF exports).
 * Keep in sync with thinking markup families, not a single vendor.
 */
export const THINKING_TAG_PAIRS: ThinkingTagPair[] = [
  {
    id: 'redacted_thinking',
    open: '<' + 'redacted_thinking' + '>',
    close: '</' + 'redacted_thinking' + '>'
  },
  { id: 'think_xml', open: '<' + 'think' + '>', close: '</' + 'think' + '>' },
  { id: 'think_special', open: '<|think|>', close: '</|think|>' },
  { id: 'seed_think', open: '<seed:think|>', close: '</seed:think|>' },
  { id: 'bracket_think', open: '[THINK]', close: '[/THINK]' },
  {
    id: 'reasoning_content',
    open: '<<<reasoning_content_start>>>',
    close: '<<<reasoning_content_end>>>'
  },
  /** Kimi / Gemma4-style empty thought marker (both tags adjacent). */
  {
    id: 'think_self_close',
    open: '<' + 'redacted_thinking' + '></' + 'redacted_thinking' + '>',
    close: null
  }
]

/** Gemma / some channel templates use a prefix + channel close (not a normal XML pair). */
const GEMMA_THOUGHT_OPEN = /<(?:\|channel\|>|\|channel>)thought\b/i
const GEMMA_THOUGHT_CLOSE = /<channel\|>/i

const THINK_FENCE_OPEN = /```\s*think\s*\n/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function openPattern(open: string): RegExp {
  return new RegExp(`${escapeRegExp(open)}\\s*`, 'i')
}

function closePattern(close: string): RegExp {
  return new RegExp(`${escapeRegExp(close)}\\s*`, 'i')
}

function splitGemmaChannelThought(raw: string, fromIndex = 0): SplitThinkingResult | null {
  const slice = raw.slice(fromIndex)
  const openMatch = GEMMA_THOUGHT_OPEN.exec(slice)
  if (!openMatch || openMatch.index == null) return null
  const afterOpen = slice.slice(openMatch.index + openMatch[0].length)
  const closeMatch = GEMMA_THOUGHT_CLOSE.exec(afterOpen)
  if (!closeMatch || closeMatch.index == null) {
    return {
      thinking: afterOpen.trim(),
      content: raw.slice(0, fromIndex + openMatch.index).trim(),
      thinkingOpen: true
    }
  }
  const thinking = afterOpen.slice(0, closeMatch.index).trim()
  const content = afterOpen.slice(closeMatch.index + closeMatch[0].length).trim()
  const prefix = raw.slice(0, fromIndex + openMatch.index).trim()
  return {
    thinking,
    content: [prefix, content].filter(Boolean).join('\n\n').trim(),
    thinkingOpen: false
  }
}

function splitThinkFence(raw: string): SplitThinkingResult | null {
  const openMatch = THINK_FENCE_OPEN.exec(raw)
  if (!openMatch || openMatch.index == null) return null
  const afterOpen = raw.slice(openMatch.index + openMatch[0].length)
  const closeIdx = afterOpen.indexOf('```')
  if (closeIdx < 0) {
    return {
      thinking: afterOpen.trim(),
      content: raw.slice(0, openMatch.index).trim(),
      thinkingOpen: true
    }
  }
  return {
    thinking: afterOpen.slice(0, closeIdx).trim(),
    content: (raw.slice(0, openMatch.index) + afterOpen.slice(closeIdx + 3)).trim(),
    thinkingOpen: false
  }
}

function splitPairedBlock(raw: string, open: RegExp, close: RegExp): SplitThinkingResult | null {
  const openMatch = open.exec(raw)
  if (!openMatch || openMatch.index == null) return null
  const afterOpen = raw.slice(openMatch.index + openMatch[0].length)
  const closeMatch = close.exec(afterOpen)
  if (!closeMatch || closeMatch.index == null) {
    return {
      thinking: afterOpen.trim(),
      content: raw.slice(0, openMatch.index).trim(),
      thinkingOpen: true
    }
  }
  const thinking = afterOpen.slice(0, closeMatch.index).trim()
  const tail = afterOpen.slice(closeMatch.index + closeMatch[0].length).trim()
  const prefix = raw.slice(0, openMatch.index).trim()
  return {
    thinking,
    content: [prefix, tail].filter(Boolean).join('\n\n').trim(),
    thinkingOpen: false
  }
}

function splitSelfClosingTag(raw: string, open: RegExp, openLen: number): SplitThinkingResult | null {
  const openMatch = open.exec(raw)
  if (!openMatch || openMatch.index == null) return null
  const tail = raw.slice(openMatch.index + openLen).trim()
  return {
    thinking: '',
    content: tail,
    thinkingOpen: false
  }
}

/** Pick the earliest thinking opener in the stream (handles models that emit multiple families). */
function splitEarliestTagPair(raw: string): SplitThinkingResult | null {
  type Candidate = { index: number; run: () => SplitThinkingResult | null }
  const candidates: Candidate[] = []

  const gemmaOpen = GEMMA_THOUGHT_OPEN.exec(raw)
  if (gemmaOpen && gemmaOpen.index != null) {
    candidates.push({ index: gemmaOpen.index, run: () => splitGemmaChannelThought(raw) })
  }

  const fenceOpen = THINK_FENCE_OPEN.exec(raw)
  if (fenceOpen && fenceOpen.index != null) {
    candidates.push({ index: fenceOpen.index, run: () => splitThinkFence(raw) })
  }

  for (const pair of THINKING_TAG_PAIRS) {
    const open = openPattern(pair.open)
    const m = open.exec(raw)
    if (!m || m.index == null) continue
    const idx = m.index
    if (pair.close === null) {
      candidates.push({
        index: idx,
        run: () => splitSelfClosingTag(raw, open, pair.open.length)
      })
    } else {
      const close = closePattern(pair.close)
      candidates.push({ index: idx, run: () => splitPairedBlock(raw, open, close) })
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0].run()
}

function stripOrphanThoughtTags(text: string): string {
  let out = text
  out = out.replace(GEMMA_THOUGHT_OPEN, '').replace(GEMMA_THOUGHT_CLOSE, '')
  for (const pair of THINKING_TAG_PAIRS) {
    out = out.replace(new RegExp(escapeRegExp(pair.open), 'gi'), '')
    if (pair.close) out = out.replace(new RegExp(escapeRegExp(pair.close), 'gi'), '')
  }
  return out.replace(/```\s*think[\s\S]*?```/gi, '').trim()
}

/**
 * Extract chain-of-thought from whatever thinking markup the active model/template emits.
 * Visible reply is returned in `content`; thinking may be empty when tags were present but blank.
 */
export function splitMessageThinking(raw: string): SplitThinkingResult {
  const text = raw ?? ''
  if (!text.trim()) {
    return { thinking: '', content: '', thinkingOpen: false }
  }

  const split = splitEarliestTagPair(text)
  if (split) return split

  return { thinking: '', content: stripOrphanThoughtTags(text), thinkingOpen: false }
}

export function hasThinkingMarkup(raw: string): boolean {
  if (!raw) return false
  if (GEMMA_THOUGHT_OPEN.test(raw)) return true
  if (THINK_FENCE_OPEN.test(raw)) return true
  return THINKING_TAG_PAIRS.some((pair) => raw.toLowerCase().includes(pair.open.toLowerCase()))
}

/** Merge persisted reasoning fields with parsed content for chat display. */
export function resolveMessageThinking(
  content: string,
  opts?: { reasoningContent?: string; reasoningOpen?: boolean }
): SplitThinkingResult {
  const split = splitMessageThinking(content)
  const stored = opts?.reasoningContent
  if (stored !== undefined && stored.trim()) {
    return {
      thinking: stored,
      content: split.content || content,
      thinkingOpen: Boolean(opts?.reasoningOpen)
    }
  }
  if (opts?.reasoningOpen || split.thinkingOpen) {
    return {
      thinking: stored?.trim() ? stored : split.thinking,
      content: split.content,
      thinkingOpen: true
    }
  }
  return split
}

export function shouldShowThinkingPanel(
  split: SplitThinkingResult,
  opts?: { streaming?: boolean; reasoningOpen?: boolean }
): boolean {
  if (split.thinking.trim()) return true
  if (split.thinkingOpen || opts?.reasoningOpen) return true
  if (opts?.streaming && hasThinkingMarkup(split.thinking + split.content)) return true
  return false
}
