import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogReleaseAssets,
  installerHostVariantIds,
  listAssetsForVariant,
  pickInferAssetForVariant
} from './llama-release-assets.mjs'

/** Asset names from llama.cpp b9272 (subset). */
const B9272 = [
  { name: 'llama-b9272-bin-win-cuda-12.4-x64.zip', browser_download_url: 'w12' },
  { name: 'llama-b9272-bin-win-cuda-13.1-x64.zip', browser_download_url: 'w13' },
  { name: 'llama-b9272-bin-win-vulkan-x64.zip', browser_download_url: 'wv' },
  { name: 'llama-b9272-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 'lv' },
  { name: 'cudart-llama-bin-win-cuda-13.1-x64.zip', browser_download_url: 'c13' }
]

/** Asset names from llama.cpp b9668 (CUDA 13.3 naming). */
const B9668 = [
  { name: 'llama-b9668-bin-win-cuda-12.4-x64.zip', browser_download_url: 'w12' },
  { name: 'llama-b9668-bin-win-cuda-13.3-x64.zip', browser_download_url: 'w133' },
  { name: 'llama-b9668-bin-win-vulkan-x64.zip', browser_download_url: 'wv' },
  { name: 'llama-b9668-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 'lv' }
]

describe('listAssetsForVariant', () => {
  it('lists win-cuda and win-vulkan zips', () => {
    const cuda = listAssetsForVariant(B9272, 'win-cuda')
    const vulkan = listAssetsForVariant(B9272, 'win-vulkan')
    assert.equal(cuda.length, 2)
    assert.equal(vulkan.length, 1)
    assert.match(vulkan[0].name, /win-vulkan/)
  })

  it('linux-cuda empty on typical release', () => {
    assert.equal(listAssetsForVariant(B9272, 'linux-cuda').length, 0)
  })

  it('linux-vulkan uses ubuntu tar.gz', () => {
    const v = listAssetsForVariant(B9272, 'linux-vulkan')
    assert.equal(v.length, 1)
    assert.match(v[0].name, /ubuntu-vulkan.*tar\.gz/)
  })

  it('lists b9668 win-cuda builds including cuda-13.3', () => {
    const cuda = listAssetsForVariant(B9668, 'win-cuda')
    assert.equal(cuda.length, 2)
    assert.ok(cuda.some((a) => /cuda-13\.3/.test(a.name)))
  })
})

describe('pickInferAssetForVariant', () => {
  it('picks CUDA 13.1 win when toolkit is 13.x', () => {
    const pick = pickInferAssetForVariant(B9272, { id: 'win-cuda', platform: 'win', arch: 'x64', gpu: 'cuda', label: 'test' }, {
      major: 13,
      minor: 2,
      label: 'CUDA 13.2',
      source: 'test'
    })
    assert.equal(pick?.name, 'llama-b9272-bin-win-cuda-13.1-x64.zip')
  })

  it('picks CUDA 13.3 win for b9668 when toolkit is 13.2', () => {
    const pick = pickInferAssetForVariant(
      B9668,
      { id: 'win-cuda', platform: 'win', arch: 'x64', gpu: 'cuda', label: 'test' },
      { major: 13, minor: 2, label: 'CUDA 13.2', source: 'test' }
    )
    assert.equal(pick?.name, 'llama-b9668-bin-win-cuda-13.3-x64.zip')
  })

  it('picks win-vulkan zip', () => {
    const pick = pickInferAssetForVariant(B9272, {
      id: 'win-vulkan',
      platform: 'win',
      arch: 'x64',
      gpu: 'vulkan',
      label: 'test'
    })
    assert.equal(pick?.name, 'llama-b9272-bin-win-vulkan-x64.zip')
  })

  it('picks linux-vulkan tar.gz', () => {
    const pick = pickInferAssetForVariant(B9272, {
      id: 'linux-vulkan',
      platform: 'linux',
      arch: 'x64',
      gpu: 'vulkan',
      label: 'test'
    })
    assert.equal(pick?.name, 'llama-b9272-bin-ubuntu-vulkan-x64.tar.gz')
  })
})

describe('catalogReleaseAssets', () => {
  it('marks linux-cuda unavailable with note', () => {
    const cat = catalogReleaseAssets(B9272, 'b9272')
    assert.equal(cat.variants['win-cuda'].available, true)
    assert.equal(cat.variants['linux-cuda'].available, false)
    assert.match(cat.variants['linux-cuda'].note ?? '', /compile from source/i)
  })
})

describe('installerHostVariantIds', () => {
  it('excludes duplicate nvidia-vulkan-windows on win32', () => {
    if (process.platform !== 'win32') return
    const ids = installerHostVariantIds()
    assert.deepEqual(ids, ['win-cuda', 'win-vulkan'])
  })
})
