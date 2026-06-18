import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickCudaLlamaAsset } from './cuda-detect.mjs'

const assets = [
  { name: 'llama-b9272-bin-win-cuda-12.4-x64.zip', browser_download_url: 'u12' },
  { name: 'llama-b9272-bin-win-cuda-13.1-x64.zip', browser_download_url: 'u13' },
  { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: 'c12' },
  { name: 'cudart-llama-bin-win-cuda-13.1-x64.zip', browser_download_url: 'c13' }
]

describe('pickCudaLlamaAsset', () => {
  it('picks CUDA 13.x when toolkit is 13.2', () => {
    const pick = pickCudaLlamaAsset(assets, {
      platform: 'win',
      cuda: { major: 13, minor: 2, label: 'CUDA 13.2', source: 'test' }
    })
    assert.equal(pick?.name, 'llama-b9272-bin-win-cuda-13.1-x64.zip')
  })

  it('picks CUDA 12.x when toolkit is 12.4', () => {
    const pick = pickCudaLlamaAsset(assets, {
      platform: 'win',
      cuda: { major: 12, minor: 4, label: 'CUDA 12.4', source: 'test' }
    })
    assert.equal(pick?.name, 'llama-b9272-bin-win-cuda-12.4-x64.zip')
  })

  it('falls back to highest major when only 12.x builds exist but toolkit is 14', () => {
    const pick = pickCudaLlamaAsset(assets, {
      platform: 'win',
      cuda: { major: 14, minor: 0, label: 'CUDA 14.0', source: 'test' }
    })
    assert.equal(pick?.name, 'llama-b9272-bin-win-cuda-13.1-x64.zip')
  })
})
