import assert from 'node:assert/strict'
import { deriveSessionTitle, isPlaceholderSessionTitle } from './chat-session-title.ts'

assert.equal(isPlaceholderSessionTitle('New chat'), true)
assert.equal(isPlaceholderSessionTitle('Hello world'), false)
assert.equal(deriveSessionTitle('  What time is it?  '), 'What time is it?')
assert.equal(
  deriveSessionTitle('[Image: pic.png]\nExplain this diagram'),
  'Explain this diagram'
)
const long = 'a'.repeat(80)
assert.ok(deriveSessionTitle(long).endsWith('…'))

console.log('chat-session-title.test.mjs: ok')
