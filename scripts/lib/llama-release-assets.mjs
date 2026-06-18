/**
 * Map Omega variants (OS × GPU) to assets on https://github.com/ggml-org/llama.cpp/releases
 * Always resolve against the requested release tag (default: latest).
 */
import { pickCudaLlamaAsset, pickCudartAsset } from './cuda-detect.mjs'

/** @typedef {'win-cuda' | 'win-vulkan' | 'linux-cuda' | 'linux-vulkan' | 'nvidia-vulkan-windows' | 'nvidia-vulkan-linux'} VariantId */
/** @typedef {{ id: VariantId, label: string, platform: 'win' | 'linux', arch: 'x64', gpu: 'cuda' | 'vulkan' }} VariantMeta */
/** @typedef {{ name: string, browser_download_url: string, size?: number }} ReleaseAsset */
/** @typedef {import('./cuda-detect.mjs').CudaInstallInfo} CudaInstallInfo */

const VARIANT_ORDER = /** @type {VariantId[]} */ ([
  'win-cuda',
  'win-vulkan',
  'nvidia-vulkan-windows',
  'linux-cuda',
  'linux-vulkan',
  'nvidia-vulkan-linux'
])

/** @type {Record<VariantId, VariantMeta>} */
export const VARIANT_META = {
  'win-cuda': {
    id: 'win-cuda',
    label: 'Windows + NVIDIA (CUDA)',
    platform: 'win',
    arch: 'x64',
    gpu: 'cuda'
  },
  'win-vulkan': {
    id: 'win-vulkan',
    label: 'Windows + Vulkan (AMD/Intel/NVIDIA)',
    platform: 'win',
    arch: 'x64',
    gpu: 'vulkan'
  },
  'linux-cuda': {
    id: 'linux-cuda',
    label: 'Linux + NVIDIA (CUDA)',
    platform: 'linux',
    arch: 'x64',
    gpu: 'cuda'
  },
  'linux-vulkan': {
    id: 'linux-vulkan',
    label: 'Linux + Vulkan (AMD/Intel/NVIDIA)',
    platform: 'linux',
    arch: 'x64',
    gpu: 'vulkan'
  },
  'nvidia-vulkan-windows': {
    id: 'nvidia-vulkan-windows',
    label: 'NVIDIA + Vulkan — Windows',
    platform: 'win',
    arch: 'x64',
    gpu: 'vulkan'
  },
  'nvidia-vulkan-linux': {
    id: 'nvidia-vulkan-linux',
    label: 'NVIDIA + Vulkan — Linux',
    platform: 'linux',
    arch: 'x64',
    gpu: 'vulkan'
  }
}

/** @param {string} name */
function archiveKind(name) {
  if (/\.zip$/i.test(name)) return 'zip'
  if (/\.tar\.gz$/i.test(name)) return 'tar.gz'
  return 'unknown'
}

/** @param {ReleaseAsset[]} assets */
function listByPattern(assets, re) {
  return assets.filter((a) => re.test(a.name))
}

/**
 * @param {ReleaseAsset[]} assets
 * @param {VariantId | VariantMeta} variantOrId
 */
export function listAssetsForVariant(assets, variantOrId) {
  const v =
    typeof variantOrId === 'string' ? VARIANT_META[/** @type {VariantId} */ (variantOrId)] : variantOrId
  if (v.gpu === 'cuda') {
    const win = listByPattern(assets, /^llama-.*bin-win-cuda-\d+\.\d+-x64\.zip$/i)
    const linux = [
      ...listByPattern(assets, /^llama-.*bin-ubuntu-cuda-\d+\.\d+-x64\.tar\.gz$/i),
      ...listByPattern(assets, /^llama-.*bin-linux-cuda-\d+\.\d+-x64\.zip$/i)
    ]
    return v.platform === 'win' ? win : linux
  }
  if (v.gpu === 'vulkan') {
    if (v.platform === 'win') {
      return listByPattern(assets, /^llama-.*bin-win-vulkan-x64\.zip$/i)
    }
    return [
      ...listByPattern(assets, /^llama-.*bin-ubuntu-vulkan-x64\.tar\.gz$/i),
      ...listByPattern(assets, /^llama-.*bin-linux-vulkan-x64\.zip$/i),
      ...listByPattern(assets, /^llama-.*bin-ubuntu-vulkan-x64\.zip$/i)
    ]
  }
  return []
}

/**
 * @param {ReleaseAsset[]} assets
 * @param {string} tagName
 */
export function catalogReleaseAssets(assets, tagName = '') {
  /** @type {Record<VariantId, { available: boolean, assets: string[], note?: string }>} */
  const variants = {}
  for (const id of VARIANT_ORDER) {
    const matches = listAssetsForVariant(assets, id)
    let note
    if ((id === 'linux-cuda' || id === 'win-cuda') && matches.length === 0) {
      note =
        'No NVIDIA CUDA prebuilt on this release — Omega will compile from source during build (needs cmake + CUDA toolkit)'
    }
    variants[id] = {
      available: matches.length > 0,
      assets: matches.map((a) => a.name),
      note
    }
  }
  return { tag: tagName, variants, totalAssets: assets.length }
}

/**
 * Print human-readable matrix for build logs.
 * @param {ReturnType<typeof catalogReleaseAssets>} catalog
 */
/**
 * @param {ReturnType<typeof catalogReleaseAssets>} catalog
 * @param {{ variantIds?: VariantId[] }} [options]
 */
export function printReleaseCatalog(catalog, options = {}) {
  const ids = options.variantIds ?? VARIANT_ORDER
  console.log(`[llama-release] GitHub release ${catalog.tag} — prebuilt matrix:`)
  for (const id of ids) {
    const row = catalog.variants[id]
    const v = VARIANT_META[id]
    if (!row || !v) continue
    if (row.available) {
      console.log(`  ✓ ${v.label}: ${row.assets.join(', ')}`)
    } else {
      console.log(`  ✗ ${v.label}: not published${row.note ? ` — ${row.note}` : ''}`)
    }
  }
}

/**
 * @param {ReleaseAsset[]} assets
 * @param {VariantMeta} variant
 * @param {CudaInstallInfo | null} [cuda]
 * @returns {ReleaseAsset | null}
 */
export function pickInferAssetForVariant(assets, variant, cuda = null) {
  if (variant.gpu === 'cuda') {
    if (variant.platform === 'win') {
      return pickCudaLlamaAsset(assets, { platform: 'win', arch: variant.arch, cuda })
    }
    return pickCudaLlamaAsset(assets, { platform: 'linux', arch: variant.arch, cuda })
  }

  if (variant.gpu === 'vulkan') {
    const candidates = listAssetsForVariant(assets, variant.id)
    if (!candidates.length) return null
    candidates.sort((a, b) => b.name.localeCompare(a.name))
    const pick = candidates[0]
    console.log(`[llama-release] ${variant.label} → ${pick.name}`)
    return pick
  }

  return null
}

/** @param {ReleaseAsset[]} assets @param {VariantMeta} variant @param {CudaInstallInfo | null} cuda */
export function pickCudartForVariant(assets, variant, cuda = null) {
  if (variant.gpu !== 'cuda' || variant.platform !== 'win') return null
  return pickCudartAsset(assets, 'win', cuda, variant.arch)
}

/** Variants that match the current process platform (win32 / linux). */
/** @returns {VariantId[]} */
export function hostVariantIds() {
  if (process.platform === 'win32') {
    return ['win-cuda', 'win-vulkan', 'nvidia-vulkan-windows']
  }
  if (process.platform === 'linux') {
    return ['linux-cuda', 'linux-vulkan', 'nvidia-vulkan-linux']
  }
  return []
}

/** Installer prompts: CUDA + Vulkan only (nvidia-vulkan-* is the same prebuilt as win/linux-vulkan). */
/** @returns {VariantId[]} */
export function installerHostVariantIds() {
  if (process.platform === 'win32') {
    return ['win-cuda', 'win-vulkan']
  }
  if (process.platform === 'linux') {
    return ['linux-cuda', 'linux-vulkan']
  }
  return []
}

export { archiveKind, VARIANT_ORDER }
