import { describe, expect, it } from 'vitest'
import {
  hasThinkingMarkup,
  resolveMessageThinking,
  shouldShowThinkingPanel,
  splitMessageThinking
} from './split-message-thinking'

function tag(openName: string, closeName?: string): { open: string; close?: string } {
  const open = String.fromCharCode(60) + openName + String.fromCharCode(62)
  const close = closeName
    ? String.fromCharCode(60, 47) + closeName + String.fromCharCode(62)
    : undefined
  return { open, close }
}

describe('splitMessageThinking', () => {
  it('splits Gemma channel thought from response', () => {
    const raw =
      '<|channel>thought\nLet me analyze the flag.\n<channel|>The symbol is the Cross of St. George.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Let me analyze the flag.')
    expect(r.content).toBe('The symbol is the Cross of St. George.')
    expect(r.thinkingOpen).toBe(false)
  })

  it('handles empty thinking with immediate close tag', () => {
    const raw = '<|channel>thought <channel|>The symbol in this image is the Cross of St. George.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('')
    expect(r.content).toContain('Cross of St. George')
  })

  it('detects open thinking while streaming', () => {
    const raw = '<|channel>thought\nStill reasoning about'
    const r = splitMessageThinking(raw)
    expect(r.thinkingOpen).toBe(true)
    expect(r.thinking).toContain('Still reasoning')
    expect(r.content).toBe('')
  })

  it('splits redacted_thinking blocks (Qwen / DeepSeek / Kimi family)', () => {
    const { open, close } = tag('redacted_thinking', 'redacted_thinking')
    const raw = open + '\nPlan A' + close! + '\nAnswer here.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Plan A')
    expect(r.content).toBe('Answer here.')
  })

  it('splits generic think XML blocks', () => {
    const { open, close } = tag('think', 'think')
    const raw = open + 'Plan A' + close! + '\nAnswer here.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Plan A')
    expect(r.content).toBe('Answer here.')
  })

  it('splits special-token think blocks', () => {
    const open = '<|think|>'
    const close = '<' + '/|think|>'
    const raw = open + 'Plan A' + close + '\nAnswer here.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Plan A')
    expect(r.content).toBe('Answer here.')
  })

  it('splits Seed OSS think blocks', () => {
    const raw = '<seed:think|>Plan A</seed:think|>\nAnswer here.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Plan A')
    expect(r.content).toBe('Answer here.')
  })

  it('splits bracket THINK blocks', () => {
    const raw = '[THINK]Plan A[/THINK]\nAnswer here.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Plan A')
    expect(r.content).toBe('Answer here.')
  })

  it('splits reasoning_content delimiters', () => {
    const raw = '<<<reasoning_content_start>>>Plan A<<<reasoning_content_end>>>Answer here.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('Plan A')
    expect(r.content).toBe('Answer here.')
  })

  it('returns plain text unchanged when no markers', () => {
    const raw = 'Hello world.'
    const r = splitMessageThinking(raw)
    expect(r.thinking).toBe('')
    expect(r.content).toBe('Hello world.')
  })
})

describe('resolveMessageThinking', () => {
  it('keeps streaming open state from message fields', () => {
    const r = resolveMessageThinking('', { reasoningContent: 'Step 1…', reasoningOpen: true })
    expect(r.thinking).toBe('Step 1…')
    expect(r.thinkingOpen).toBe(true)
  })
})

describe('shouldShowThinkingPanel', () => {
  it('shows while reasoning stream is open', () => {
    expect(
      shouldShowThinkingPanel(
        { thinking: '', content: '', thinkingOpen: false },
        { streaming: true, reasoningOpen: true }
      )
    ).toBe(true)
  })
})

describe('hasThinkingMarkup', () => {
  it('detects channel thought opener', () => {
    expect(hasThinkingMarkup('<|channel>thought hi')).toBe(true)
    expect(hasThinkingMarkup('plain')).toBe(false)
  })
})
