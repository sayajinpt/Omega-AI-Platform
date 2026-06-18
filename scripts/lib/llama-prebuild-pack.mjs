/**
 * Which @node-llama-cpp prebuild packages belong in the installer for a given variant.
 */
import { VARIANTS } from './llama-variants.mjs'

/**
 * @param {import('./llama-variants.mjs').LlamaVariant | null} variant
 * @returns {string[]}
 */
export function prebuiltPkgsForInstaller(variant) {
  if (!variant) {
    const host = process.platform
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    if (host === 'darwin') {
      return [`@node-llama-cpp/mac-${arch}`, `@node-llama-cpp/mac-${arch}-metal`]
    }
    if (host === 'win32') {
      return [
        '@node-llama-cpp/win-x64',
        '@node-llama-cpp/win-x64-cuda',
        '@node-llama-cpp/win-x64-cuda-ext'
      ]
    }
    return [
      '@node-llama-cpp/linux-x64',
      '@node-llama-cpp/linux-x64-cuda',
      '@node-llama-cpp/linux-x64-cuda-ext'
    ]
  }

  const list = [...variant.prebuiltPkgs]
  if (variant.gpu === 'cuda') {
    const ext = `@node-llama-cpp/${variant.platform}-x64-cuda-ext`
    if (!list.includes(ext)) list.push(ext)
  }
  return list
}

/** @param {string} id */
export function prebuiltPkgsForVariantId(id) {
  const v = VARIANTS[/** @type {keyof VARIANTS} */ (id)]
  return v ? prebuiltPkgsForInstaller(v) : prebuiltPkgsForInstaller(null)
}
