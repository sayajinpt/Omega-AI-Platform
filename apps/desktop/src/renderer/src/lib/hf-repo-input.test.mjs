import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseHfRepoInput } from './hf-repo-input.ts'

describe('parseHfRepoInput', () => {
  it('parses huggingface.co model URLs', () => {
    assert.equal(
      parseHfRepoInput('https://huggingface.co/bartowski/mistralai_Devstral-Small-2505-GGUF'),
      'bartowski/mistralai_Devstral-Small-2505-GGUF'
    )
    assert.equal(
      parseHfRepoInput('https://huggingface.co/models/meta-llama/Llama-3.1-8B'),
      'meta-llama/Llama-3.1-8B'
    )
  })

  it('parses owner/repo shorthand', () => {
    assert.equal(parseHfRepoInput('bartowski/Qwen_Qwen3-8B-GGUF'), 'bartowski/Qwen_Qwen3-8B-GGUF')
  })

  it('rejects invalid input', () => {
    assert.equal(parseHfRepoInput('devstral'), null)
    assert.equal(parseHfRepoInput(''), null)
  })
})
