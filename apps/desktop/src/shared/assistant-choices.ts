/**
 * Parse assistant ```choices``` blocks into clickable MessagePart suggestions.
 */
import type { MessagePart } from '@omega/sdk'
import { dedupeMessageParts } from './message-parts'
import { splitMessageThinking, hasThinkingMarkup } from './split-message-thinking'

export type AssistantChoiceOption = {
  id: string
  label: string
  description?: string
  value: string
}

export type AssistantChoicesPayload = {
  prompt?: string
  allowCustom?: boolean
  multiSelect?: boolean
  inputKind?: 'text' | 'textarea'
  options: AssistantChoiceOption[]
}

let inChoicesFence = false

export function looksLikeChoicesStart(text: string): boolean {
  return /```\s*choices/i.test(text)
}

export function resetChoicesStreamState(): void {
  inChoicesFence = false
}

let inToolFence = false

export function looksLikeToolStart(text: string): boolean {
  return /```\s*tool\b/i.test(text) || /"name"\s*:\s*"write_file"/i.test(text) ||
    /<\|tool_call\|>/i.test(text) || /<\|tool_call>call:/i.test(text) ||
    /<\s*omega_turn\b/i.test(text) || /<\s*briefing\b/i.test(text) || /<\s*tools\b/i.test(text)
}

export function resetToolStreamState(): void {
  inToolFence = false
}

export function resetAgentStreamState(): void {
  resetChoicesStreamState()
  resetToolStreamState()
}

export function stripToolArtifacts(text: string): string {
  let out = text
  out = out.replace(/```tool\s*\n[\s\S]*?```/gi, '')
  out = out.replace(/```\s*tool[\s\S]*$/gi, '')
  out = out.replace(/<\|tool_call>call:[\s\S]*?<tool_call\|>/gi, '')
  out = out.replace(/<\|tool_call>call:[\s\S]*$/gi, '')
  out = out.replace(/<(?:\|)?tool_call(?:\|)?>[\s\S]*?<\/(?:\|)?tool_call(?:\|)?>/gi, '')
  out = out.replace(/<\s*omega_turn[\s\S]*?<\/\s*omega_turn\s*>/gi, '')
  out = out.replace(/<\s*omega_turn[\s\S]*$/gi, '')
  out = out.replace(/<\/?\s*briefing\s*>[\s\S]*?<\/\s*briefing\s*>/gi, '')
  out = out.replace(/<\/?\s*tools\s*>[\s\S]*?<\/\s*tools\s*>/gi, '')
  out = out.replace(/\{\s*"name"\s*:\s*"write_file"[\s\S]*$/gi, '')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

/** Hide tool/choices markup from streamed chat text. */
export function shouldStreamAgentMarkup(accumulated: string): boolean {
  if (looksLikeChoicesStart(accumulated)) return false
  const choicesOpen = (accumulated.match(/```choices/gi) || []).length
  const fenceCount = (accumulated.match(/```/g) || []).length
  if (choicesOpen > fenceCount - choicesOpen) return false

  if (looksLikeToolStart(accumulated)) return false
  const toolOpen = (accumulated.match(/```tool/gi) || []).length
  if (toolOpen > fenceCount - toolOpen) return false
  if (/"name"\s*:\s*"write_file"/i.test(accumulated) && accumulated.includes('{')) return false
  return true
}

/** @deprecated Use shouldStreamAgentMarkup */
export function shouldStreamChoicesTokens(accumulated: string): boolean {
  return shouldStreamAgentMarkup(accumulated)
}

/** @deprecated Use shouldStreamAgentMarkup */
export function shouldStreamToolTokens(accumulated: string): boolean {
  return shouldStreamAgentMarkup(accumulated)
}

export function stripChoicesArtifacts(text: string): string {
  let out = text
  out = out.replace(/```choices\s*\n[\s\S]*?```/gi, '')
  out = out.replace(/```\s*choices[\s\S]*$/gi, '')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

/** Collapse repeated paragraphs (e.g. duplicate tool status lines). */
export function dedupeDuplicateParagraphs(text: string): string {
  const paras = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const p of paras) {
    if (out[out.length - 1] !== p) out.push(p)
  }
  return out.join('\n\n')
}

function normalizeOptions(raw: unknown): AssistantChoiceOption[] {
  if (!Array.isArray(raw)) return []
  const out: AssistantChoiceOption[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i] as Record<string, unknown>
    const label = String(o.label ?? o.text ?? '').trim()
    const value = String(o.value ?? label).trim()
    if (!label && !value) continue
    const id = String(o.id ?? `opt-${i + 1}`).trim() || `opt-${i + 1}`
    const description = o.description != null ? String(o.description).trim() : undefined
    out.push({ id, label: label || value, value, description: description || undefined })
  }
  return out
}

function tryParseChoicesJson(raw: string): AssistantChoicesPayload | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    const inputKind = obj.inputKind === 'textarea' ? 'textarea' : undefined
    const options = normalizeOptions(obj.options ?? obj.choices ?? obj.items)
    const allowCustom =
      obj.allowCustom === true || obj.allow_custom === true || inputKind === 'textarea'
    if (!options.length && !(allowCustom && inputKind === 'textarea')) return null
    return {
      prompt: obj.prompt != null ? String(obj.prompt).trim() : undefined,
      allowCustom,
      multiSelect: obj.multiSelect === true || obj.multi_select === true,
      inputKind,
      options
    }
  } catch {
    return null
  }
}

export function parseChoicesFromText(text: string): AssistantChoicesPayload | null {
  const re = /```choices\s*\n?([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const parsed = tryParseChoicesJson(m[1])
    if (parsed) return parsed
  }
  const open = /```choices\s*\n?([\s\S]*)$/i.exec(text)
  if (open) {
    const parsed = tryParseChoicesJson(open[1])
    if (parsed) return parsed
  }
  return null
}

export function choicesPayloadToPart(payload: AssistantChoicesPayload): MessagePart {
  return {
    type: 'choices',
    prompt: payload.prompt,
    allowCustom: payload.allowCustom,
    multiSelect: payload.multiSelect,
    inputKind: payload.inputKind,
    options: payload.options,
    status: 'pending'
  }
}

/** Split raw assistant text into display markdown + optional choices part. */
export function splitAssistantMessageContent(
  rawText: string
): { text: string; choicesPart: MessagePart | null } {
  const payload = parseChoicesFromText(rawText)
  const text = stripToolArtifacts(stripChoicesArtifacts(rawText))
  return {
    text,
    choicesPart: payload ? choicesPayloadToPart(payload) : null
  }
}

/** Strip chat-template stop tokens and decode replacement chars from visible assistant text. */
export function stripChatStreamArtifacts(text: string): string {
  let out = text ?? ''
  out = out.replace(/<\|(?:redacted_)?im_end\|>/gi, '')
  out = out.replace(/<\|endoftext\|>/gi, '')
  out = out.replace(/<\|end\|>/gi, '')
  out = out.replace(/<\|assistant\|>/gi, '')
  out = out.replace(/<\|user\|>/gi, '')
  out = out.replace(/<\|[^\n>]*$/g, '')
  out = out.replace(/\uFFFD/g, '')
  out = out.replace(/\0/g, '')
  return out
}

export function buildAssistantMessageParts(
  rawText: string,
  extraParts: MessagePart[] = []
): {
  content: string
  parts?: MessagePart[]
  reasoningContent?: string
  reasoningOpen?: boolean
} {
  const { text, choicesPart } = splitAssistantMessageContent(
    stripToolArtifacts(stripChoicesArtifacts(stripChatStreamArtifacts(rawText)))
  )
  const split = splitMessageThinking(text)
  const visible = split.content || (split.thinkingOpen ? '' : text)
  const hasChoiceParts = extraParts.some((p) => p.type === 'choices')
  const hasCodePart = extraParts.some(
    (p) => p.type === 'text' && (p.text ?? '').includes('```')
  )
  const parts: MessagePart[] = []
  const visibleNorm = visible.trim()
  const statusOnly =
    hasCodePart && /^wrote\s+\S+/i.test(visibleNorm) && !visibleNorm.includes('```')
  if (visibleNorm && !statusOnly) parts.push({ type: 'text', text: visible })
  if (choicesPart && !hasChoiceParts) parts.push(choicesPart)
  for (const p of extraParts) {
    if (p.type === 'text') {
      const t = (p.text ?? '').trim()
      if (!t) continue
      if (hasCodePart && /^wrote\s+\S+/i.test(t) && !t.includes('```')) continue
      // Preserve tool-result code fences (write_file / read_file) and other non-duplicate text.
      if (t.includes('```') || t !== visibleNorm) parts.push(p)
      continue
    }
    parts.push(p)
  }
  const merged = dedupeMessageParts(parts)
  const hasReasoning =
    split.thinking.trim().length > 0 || split.thinkingOpen || hasThinkingMarkup(text)
  const reasoningContent = hasReasoning ? split.thinking : undefined
  const reasoningOpen = split.thinkingOpen || (hasReasoning && split.thinking.trim().length === 0 && hasThinkingMarkup(text))
  const strippedFallback = dedupeDuplicateParagraphs(
    stripToolArtifacts(stripChoicesArtifacts(stripChatStreamArtifacts(rawText))).trim()
  )
  const safeContent = dedupeDuplicateParagraphs(statusOnly ? '' : visible.trim() || strippedFallback)
  if (!merged.length) {
    return {
      content: safeContent,
      parts: undefined,
      reasoningContent,
      reasoningOpen
    }
  }
  return { content: safeContent || visible, parts: merged, reasoningContent, reasoningOpen }
}

export const ASSISTANT_CHOICES_FORMAT = `## Clarifying questions (clickable suggestions)
When you need **one or more parameters** from the user (duration, style, language, yes/no, pick one of several options), ask in normal prose **and** append a fenced **choices** block so the UI can show clickable options.

\`\`\`choices
{
  "prompt": "Short question shown above the buttons",
  "allowCustom": true,
  "multiSelect": false,
  "options": [
    { "id": "30s", "label": "30 seconds", "value": "30 seconds" },
    { "id": "60s", "label": "1 minute", "value": "60 seconds" }
  ]
}
\`\`\`

Rules:
- **2–6 options**; \`value\` is what you will treat as the user's answer when they click (complete sentence or parameter value).
- Set \`allowCustom: true\` when none of the presets may fit.
- Use \`multiSelect: true\` only when several selections are valid; otherwise single pick.
- Do **not** put the JSON options list only in prose — always include the \`choices\` fence.
- Never use \`choices\` for tool calls (use \`tool\` fences).`
