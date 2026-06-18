import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MODEL_HUB } from './model-hub.ts'

describe('model-hub catalog', () => {
  it('does not use removed Devstral repo slug', () => {
    const dev = MODEL_HUB.find((h) => h.id === 'devstral-24b')
    assert.ok(dev)
    assert.notEqual(dev.repo, 'bartowski/devstral-24B-GGUF')
    assert.match(dev.repo, /mistralai_Devstral-Small/i)
    assert.match(dev.file, /Devstral-Small.*Q4_K_M\.gguf/i)
  })

  it('uses owner/repo paths with a slash', () => {
    for (const h of MODEL_HUB) {
      assert.match(h.repo, /^[^/]+\/[^/]+$/, `invalid repo for ${h.id}: ${h.repo}`)
    }
  })
})
