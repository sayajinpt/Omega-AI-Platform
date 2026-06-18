import { describe, expect, it } from 'vitest'
import { runtimeModelId } from './model-id'

/** Mirrors omegaRuntimeModelId path stem logic (no fs in unit test). */
function stemFromGgufPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path
  return base.replace(/\.gguf$/i, '')
}

describe('runtime model id vs pack folder', () => {
  it('pack folder id differs from omega-runtime registry stem', () => {
    const packId = 'gemma-4-26B-A4B-it-GGUF'
    const filePath = 'C:/models/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf'
    expect(runtimeModelId(packId)).toBe(packId)
    expect(stemFromGgufPath(filePath)).toBe('gemma-4-26B-A4B-it-Q4_K_M')
    expect(stemFromGgufPath(filePath)).not.toBe(packId)
  })
})
