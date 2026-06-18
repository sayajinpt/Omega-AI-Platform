/**
 * Map llama-setup variant → omega-engine (libomega_infer) CMake GPU flags.
 * Chat GGUF inference uses dist/engine/omega-engine.exe, not dist/bin prebuilts alone.
 */
import { fileURLToPath } from 'node:url'
import { readPrimaryVariant } from './llama-lock.mjs'
import { resolveVariant } from './llama-variants.mjs'
import { detectInstalledCuda } from './cuda-detect.mjs'
import { detectInstalledVulkan } from './vulkan-detect.mjs'

/**
 * @param {string} [root] repo root
 * @returns {{ variantId: string | null, gpu: 'cuda' | 'vulkan' | 'cpu', enableCuda: boolean, enableVulkan: boolean, reason: string, vulkanSdk?: import('./vulkan-detect.mjs').VulkanInstallInfo | null }}
 */
export function resolveEngineGpuBuildOptions(root = process.cwd()) {
  const envVariant = process.env.OMEGA_LLAMA_VARIANT?.trim()
  let variant = null
  if (envVariant) {
    try {
      variant = resolveVariant(envVariant)
    } catch {
      /* fall through to lock */
    }
  }
  if (!variant) {
    const { variant: fromLock } = readPrimaryVariant(root)
    variant = fromLock
  }

  if (process.env.OMEGA_GGML_CUDA === '1') {
    return {
      variantId: variant?.id ?? null,
      gpu: 'cuda',
      enableCuda: true,
      enableVulkan: false,
      reason: 'OMEGA_GGML_CUDA=1'
    }
  }
  if (process.env.OMEGA_ENGINE_CPU_ONLY === '1') {
    return {
      variantId: variant?.id ?? null,
      gpu: 'cpu',
      enableCuda: false,
      enableVulkan: false,
      reason: 'OMEGA_ENGINE_CPU_ONLY=1'
    }
  }
  if (process.env.OMEGA_GGML_VULKAN === '1') {
    const vulkan = detectInstalledVulkan()
    return {
      variantId: variant?.id ?? null,
      gpu: 'vulkan',
      enableCuda: false,
      enableVulkan: true,
      vulkanSdk: vulkan,
      reason: vulkan ? `OMEGA_GGML_VULKAN=1 + ${vulkan.label}` : 'OMEGA_GGML_VULKAN=1'
    }
  }

  if (!variant) {
    const cuda = detectInstalledCuda()
    if (cuda) {
      return {
        variantId: null,
        gpu: 'cuda',
        enableCuda: true,
        enableVulkan: false,
        reason: `no variant lock; ${cuda.label} toolkit detected`
      }
    }
    return {
      variantId: null,
      gpu: 'cpu',
      enableCuda: false,
      enableVulkan: false,
      reason: 'no variant lock and no CUDA toolkit'
    }
  }

  if (variant.gpu === 'cuda') {
    const cuda = detectInstalledCuda()
    return {
      variantId: variant.id,
      gpu: cuda ? 'cuda' : 'cpu',
      enableCuda: !!cuda,
      enableVulkan: false,
      reason: cuda
        ? `variant ${variant.id} + ${cuda.label}`
        : `variant ${variant.id} but CUDA toolkit not found — CPU-only engine`
    }
  }

  const vulkan = detectInstalledVulkan()
  return {
    variantId: variant.id,
    gpu: vulkan ? 'vulkan' : 'cpu',
    enableCuda: false,
    enableVulkan: !!vulkan,
    vulkanSdk: vulkan,
    reason: vulkan
      ? `variant ${variant.id} + ${vulkan.label}`
      : `variant ${variant.id} but Vulkan SDK not found — CPU-only engine (install LunarG Vulkan SDK for GPU layers in omega-engine)`
  }
}

/**
 * Explicit CMake flags so stale GGML_CUDA/GGML_VULKAN cache cannot leak across variant switches.
 * @param {{ enableCuda: boolean, enableVulkan: boolean }} gpu
 * @returns {string[]}
 */
export function buildCmakeGpuArgs(gpu) {
  if (gpu.enableCuda) {
    return ['-DOMEGA_GGML_CUDA=ON', '-DOMEGA_GGML_VULKAN=OFF']
  }
  if (gpu.enableVulkan) {
    return ['-DOMEGA_GGML_CUDA=OFF', '-DOMEGA_GGML_VULKAN=ON']
  }
  return ['-DOMEGA_GGML_CUDA=OFF', '-DOMEGA_GGML_VULKAN=OFF']
}

/** @param {{ variantId: string | null, gpu: string, enableCuda: boolean, enableVulkan: boolean }} gpu */
export function engineBuildCacheKey(gpu) {
  return `${gpu.variantId ?? 'none'}:${gpu.gpu}:cuda=${gpu.enableCuda}:vulkan=${gpu.enableVulkan}:simd=portable-v1:cuda-arch=real-v1`
}

/** CLI: node scripts/lib/engine-gpu-backend.mjs */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gpu = resolveEngineGpuBuildOptions()
  if (process.argv.includes('--cmake-args')) {
    console.log(JSON.stringify(buildCmakeGpuArgs(gpu)))
    process.exit(0)
  }
  if (process.argv.includes('--cache-key')) {
    console.log(engineBuildCacheKey(gpu))
    process.exit(0)
  }
  console.log(JSON.stringify(gpu))
}
