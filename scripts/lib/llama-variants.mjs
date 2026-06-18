/**
 * Omega llama.cpp build matrix: OS × GPU backend.
 * Each variant must be built on its host OS (no cross-compile).
 */
import { pickInferAssetForVariant } from './llama-release-assets.mjs'

/** @typedef {'win-cuda' | 'win-vulkan' | 'linux-cuda' | 'linux-vulkan' | 'nvidia-vulkan-windows' | 'nvidia-vulkan-linux'} VariantId */

/** User-facing aliases (typos / alternate spellings) → canonical variant id. */
const VARIANT_ALIASES = {
  'nvidia+vulkan-windows': 'nvidia-vulkan-windows',
  'nvidia.vulkan-windows': 'nvidia-vulkan-windows',
  'nvidia+vulcan-windows': 'nvidia-vulkan-windows',
  'nvidia.vulcan-windows': 'nvidia-vulkan-windows',
  'nvidia+vulkan-linux': 'nvidia-vulkan-linux',
  'nvidia.vulkan-linux': 'nvidia-vulkan-linux',
  'nvidia+vulcan-linux': 'nvidia-vulkan-linux',
  'nvidia.vulcan-linux': 'nvidia-vulkan-linux'
}

/** @typedef {{ id: VariantId, label: string, host: 'win32' | 'linux', platform: 'win' | 'linux', arch: 'x64', gpu: 'cuda' | 'vulkan', inferSubdir: string }} LlamaVariant */

/** @type {Record<VariantId, LlamaVariant>} */
export const VARIANTS = {
  'win-cuda': {
    id: 'win-cuda',
    label: 'Windows + NVIDIA (CUDA)',
    host: 'win32',
    platform: 'win',
    arch: 'x64',
    gpu: 'cuda',
    inferSubdir: 'win-cuda'
  },
  'win-vulkan': {
    id: 'win-vulkan',
    label: 'Windows + Vulkan (AMD/Intel/NVIDIA)',
    host: 'win32',
    platform: 'win',
    arch: 'x64',
    gpu: 'vulkan',
    inferSubdir: 'win-vulkan'
  },
  'linux-cuda': {
    id: 'linux-cuda',
    label: 'Linux + NVIDIA (CUDA)',
    host: 'linux',
    platform: 'linux',
    arch: 'x64',
    gpu: 'cuda',
    inferSubdir: 'linux-cuda'
  },
  'linux-vulkan': {
    id: 'linux-vulkan',
    label: 'Linux + Vulkan (AMD/Intel/NVIDIA)',
    host: 'linux',
    platform: 'linux',
    arch: 'x64',
    gpu: 'vulkan',
    inferSubdir: 'linux-vulkan'
  },
  'nvidia-vulkan-windows': {
    id: 'nvidia-vulkan-windows',
    label: 'NVIDIA + Vulkan — Windows',
    host: 'win32',
    platform: 'win',
    arch: 'x64',
    gpu: 'vulkan',
    inferSubdir: 'nvidia-vulkan-windows'
  },
  'nvidia-vulkan-linux': {
    id: 'nvidia-vulkan-linux',
    label: 'NVIDIA + Vulkan — Linux',
    host: 'linux',
    platform: 'linux',
    arch: 'x64',
    gpu: 'vulkan',
    inferSubdir: 'nvidia-vulkan-linux'
  }
}

/** @param {string} id */
export function resolveVariant(id) {
  const raw = id?.trim().toLowerCase()
  const key = VARIANT_ALIASES[raw] ?? raw
  const v = VARIANTS[/** @type {VariantId} */ (key)]
  if (!v) {
    throw new Error(
      `Unknown variant "${id}". Use: ${Object.keys(VARIANTS).join(', ')}`
    )
  }
  return v
}

/** @param {LlamaVariant} variant */
export function assertHostOs(variant) {
  if (process.platform !== variant.host) {
    throw new Error(
      `${variant.label} must be built on ${variant.host} (current: ${process.platform}).\n` +
        `  Run this on the target OS, or use CI for that platform.`
    )
  }
}

/** @typedef {import('./cuda-detect.mjs').CudaInstallInfo} CudaInstallInfo */

/** @param {{ name: string }[]} assets @param {LlamaVariant} variant @param {CudaInstallInfo | null} [cuda] */
export function pickInferAsset(assets, variant, cuda = null) {
  const pick = (re) => assets.find((a) => re.test(a.name))
  const main = pickInferAssetForVariant(assets, variant, cuda)
  if (main) return main
  if (variant.platform === 'win' && variant.gpu === 'cuda') {
    return pick(/^llama-.*bin-win-cpu-x64\.zip$/) ?? null
  }
  return null
}

/** Variants buildable on this machine. */
export function variantsForHost() {
  const host = process.platform
  return Object.values(VARIANTS).filter((v) => v.host === host)
}

/** Installer / build.bat: CUDA + one Vulkan option (no duplicate nvidia-vulkan-* labels). */
export function variantsForInstaller() {
  if (process.platform === 'win32') {
    return [VARIANTS['win-cuda'], VARIANTS['win-vulkan']]
  }
  if (process.platform === 'linux') {
    return [VARIANTS['linux-cuda'], VARIANTS['linux-vulkan']]
  }
  return []
}

/** Legacy lock / CLI alias → canonical variant (same prebuilt binaries). */
export function normalizeInstallerVariantId(id) {
  const raw = id?.trim().toLowerCase()
  if (raw === 'nvidia-vulkan-windows') return 'win-vulkan'
  if (raw === 'nvidia-vulkan-linux') return 'linux-vulkan'
  return raw
}

/** @param {LlamaVariant} variant @param {string} tag */
export function localBuildFolder(variant, tag = 'b9247') {
  const gpuPart = variant.gpu === 'cuda' ? 'cuda' : 'vulkan'
  return `${variant.platform}-x64-${gpuPart}-release-${tag}`
}
