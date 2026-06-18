import { describe, expect, it } from 'vitest'
import { modelIdsMatch, normalizeModelId } from './model-id'

describe('normalizeModelId', () => {
  it('keeps pack folder ids with version dots', () => {
    expect(normalizeModelId('Qwopus3.5-9B-Coder-GGUF')).toBe('Qwopus3.5-9B-Coder-GGUF')
    expect(normalizeModelId('Qwen_Qwen3-8B-GGUF')).toBe('Qwen_Qwen3-8B-GGUF')
  })

  it('appends .gguf only for bare filename stems with quant suffix', () => {
    expect(normalizeModelId('Llama-3-8B-Q4_K_M')).toBe('Llama-3-8B-Q4_K_M.gguf')
  })

  it('leaves ids that already include a weight extension', () => {
    expect(normalizeModelId('Llama-3-8B-Q4_K_M.gguf')).toBe('Llama-3-8B-Q4_K_M.gguf')
  })

  it('matches pack folder id to wrongly suffixed .gguf id', () => {
    expect(
      modelIdsMatch('Qwopus3.5-9B-Coder-GGUF', 'Qwopus3.5-9B-Coder-GGUF.gguf')
    ).toBe(true)
  })
})
