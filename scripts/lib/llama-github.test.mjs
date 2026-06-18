import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeIncompleteWindowsAssets, normalizeTag } from './llama-github.mjs'

describe('normalizeTag', () => {
  it('preserves latest', () => {
    assert.equal(normalizeTag('latest'), 'latest')
    assert.equal(normalizeTag('LATEST'), 'latest')
  })

  it('adds b prefix for numeric tags', () => {
    assert.equal(normalizeTag('9668'), 'b9668')
    assert.equal(normalizeTag('b9668'), 'b9668')
  })
})

describe('looksLikeIncompleteWindowsAssets', () => {
  it('flags linux-only snapshots on win32', () => {
    const assets = [{ name: 'llama-b9668-bin-ubuntu-vulkan-x64.tar.gz' }]
    assert.equal(looksLikeIncompleteWindowsAssets(assets), true)
  })

  it('accepts complete windows matrix', () => {
    const assets = [
      { name: 'llama-b9668-bin-win-cuda-13.3-x64.zip' },
      { name: 'llama-b9668-bin-win-vulkan-x64.zip' }
    ]
    assert.equal(looksLikeIncompleteWindowsAssets(assets), false)
  })
})
