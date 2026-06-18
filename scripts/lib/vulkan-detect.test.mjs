import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyVulkanSdkToEnv, detectInstalledVulkan } from './vulkan-detect.mjs'

describe('detectInstalledVulkan', () => {
  it('finds a Vulkan SDK on Windows when C:\\VulkanSDK is populated', () => {
    if (process.platform !== 'win32') return
    const hit = detectInstalledVulkan()
    if (!hit) {
      console.log('[vulkan-detect.test] skip — no Vulkan SDK on this machine')
      return
    }
    assert.ok(hit.root)
    assert.match(hit.root, /VulkanSDK/i)
    assert.ok(hit.glslc.toLowerCase().endsWith('glslc.exe'))
  })
})

describe('applyVulkanSdkToEnv', () => {
  it('sets VULKAN_SDK from a normalized install record', () => {
    const env = applyVulkanSdkToEnv({}, {
      root: 'C:\\VulkanSDK\\1.0.0.0',
      label: 'test',
      glslc: 'C:\\VulkanSDK\\1.0.0.0\\Bin\\glslc.exe',
      source: 'test'
    })
    assert.equal(env.VULKAN_SDK, 'C:\\VulkanSDK\\1.0.0.0')
  })
})
