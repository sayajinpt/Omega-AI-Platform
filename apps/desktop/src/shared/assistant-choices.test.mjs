import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAssistantMessageParts,
  parseChoicesFromText,
  splitAssistantMessageContent,
  stripChoicesArtifacts,
  stripToolArtifacts
} from './assistant-choices.ts'

describe('assistant-choices', () => {
  it('parses fenced choices block', () => {
    const raw = `Which length?

\`\`\`choices
{"prompt":"How long?","allowCustom":true,"options":[{"id":"a","label":"30s","value":"30 seconds"}]}
\`\`\``
    const payload = parseChoicesFromText(raw)
    assert.equal(payload?.options.length, 1)
    const { text, choicesPart } = splitAssistantMessageContent(raw)
    assert.match(text, /Which length/)
    assert.equal(choicesPart?.type, 'choices')
  })

  it('strips choices from display text', () => {
    const raw = 'Pick one\n```choices\n{"options":[{"id":"1","label":"A","value":"A"}]}\n```'
    assert.equal(stripChoicesArtifacts(raw), 'Pick one')
  })

  it('builds parts with text and choices', () => {
    const built = buildAssistantMessageParts(
      'Question?\n```choices\n{"options":[{"id":"1","label":"Yes","value":"yes please"}]}\n```'
    )
    assert.equal(built.parts?.length, 2)
    assert.equal(built.parts?.[0]?.type, 'text')
    assert.equal(built.parts?.[1]?.type, 'choices')
  })

  it('strips trailing chat-template artifacts from assistant text', () => {
    const built = buildAssistantMessageParts('Hello!\uFFFD\uFFFD<|im_end|>')
    assert.equal(built.content, 'Hello!')
  })

  it('strips tool markup from display text', () => {
    const raw =
      'Here you go\n```tool\n{"name":"write_file","args":{"path":"code/game.html","content":"<!DOCTYPE html>"}}\n```'
    assert.equal(stripToolArtifacts(raw), 'Here you go')
  })

  it('preserves tool-result code fence parts from extraParts', () => {
    const code = '```html\n<!DOCTYPE html><title>Game</title>\n```'
    const built = buildAssistantMessageParts('Saved code/game.html', [{ type: 'text', text: code }])
    assert.equal(built.parts?.length, 2)
    assert.match(built.parts?.[1]?.type === 'text' ? built.parts[1].text : '', /<!DOCTYPE html>/)
  })

  it('does not duplicate choices when extraParts already include them', () => {
    const built = buildAssistantMessageParts(
      'Pick GPU mode\n```choices\n{"prompt":"Choose GPU mode","options":[{"id":"a","label":"Keep agent loaded","value":"keep_agent"}]}\n```',
      [
        {
          type: 'choices',
          prompt: 'Choose GPU mode for Content Studio render',
          options: [{ id: 'max', label: 'Max performance', value: 'max_performance' }],
          status: 'pending'
        }
      ]
    )
    const choiceParts = built.parts?.filter((p) => p.type === 'choices') ?? []
    assert.equal(choiceParts.length, 1)
  })
})
