#!/usr/bin/env node
/**
 * Download llama.cpp prebuilt binaries into dist/bin/<variant>/.
 * Always resolves the requested GitHub release (default: latest) per variant.
 *
 * Usage:
 *   node scripts/fetch-infer-binaries.mjs [--force] [--tag=latest]
 *   node scripts/fetch-infer-binaries.mjs --variant=win-cuda [--force]
 *   node scripts/fetch-infer-binaries.mjs --all-host-variants [--force] [--installer]
 *   node scripts/fetch-infer-binaries.mjs --catalog-only [--tag=latest] [--installer]
 *   node scripts/fetch-infer-binaries.mjs --cpu-only   (legacy: dist/bin root, CPU/CUDA auto)
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectInstalledCuda } from './lib/cuda-detect.mjs'
import { installAllHostVariants, installInferVariant } from './lib/fetch-infer-install.mjs'
import { fetchRelease, normalizeTag } from './lib/llama-github.mjs'
import {
  catalogReleaseAssets,
  hostVariantIds,
  installerHostVariantIds,
  printReleaseCatalog
} from './lib/llama-release-assets.mjs'
import { assertHostOs, resolveVariant, variantsForHost } from './lib/llama-variants.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force')
const cpuOnly = process.argv.includes('--cpu-only')
const allHost = process.argv.includes('--all-host-variants')
const catalogOnly = process.argv.includes('--catalog-only')
const installerCatalog = process.argv.includes('--installer')
const variantArg = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1]
const tagArg = process.argv.find((a) => a.startsWith('--tag='))?.split('=')[1]

/** Legacy macOS / no-variant: install first host CUDA variant or Vulkan fallback into dist/bin. */
async function installLegacyDefault(release, cuda) {
  const host = variantsForHost()
  const prefer = host.find((v) => v.gpu === 'cuda') ?? host.find((v) => v.gpu === 'vulkan') ?? host[0]
  if (!prefer) {
    console.error('[fetch-infer] No variant for this platform')
    process.exit(1)
  }
  const binDir = join(root, 'dist', 'bin')
  const variant = { ...prefer, inferSubdir: '.' }
  const tmp = { ...variant, inferSubdir: prefer.inferSubdir }
  await installInferVariant({ root, variant: tmp, release, force, cuda })
  const { copyFileSync, existsSync, mkdirSync, readdirSync } = await import('node:fs')
  const srcDir = join(root, 'dist', 'bin', prefer.inferSubdir)
  mkdirSync(binDir, { recursive: true })
  if (!existsSync(srcDir)) return
  for (const name of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, name), join(binDir, name))
  }
  console.log(`[fetch-infer] Legacy promote ${prefer.id} → dist/bin/`)
}

async function main() {
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) {
    console.error(`[fetch-infer] Unsupported platform: ${process.platform}`)
    process.exit(1)
  }

  const tag = tagArg ? normalizeTag(tagArg) : 'latest'
  console.log(`[fetch-infer] GitHub release: ${tag} (https://github.com/ggml-org/llama.cpp/releases)`)
  const release = await fetchRelease(tag, { root })

  const catalog = catalogReleaseAssets(release.assets ?? [], release.tag_name)
  const catalogIds = installerCatalog ? installerHostVariantIds() : undefined
  printReleaseCatalog(catalog, catalogIds?.length ? { variantIds: catalogIds } : {})

  if (catalogOnly) return

  const cuda = cpuOnly ? null : detectInstalledCuda()
  if (cuda) {
    console.log(`[fetch-infer] System CUDA: ${cuda.label} (${cuda.source})`)
  } else if (!cpuOnly) {
    console.log('[fetch-infer] CUDA toolkit not detected — newest CUDA build on release when applicable')
  }

  if (allHost) {
    const ids = installerCatalog ? installerHostVariantIds() : hostVariantIds()
    if (!ids.length) {
      console.error('[fetch-infer] --all-host-variants requires Windows or Linux')
      process.exit(1)
    }
    const results = await installAllHostVariants({ root, release, variantIds: ids, force })
    const failed = results.filter((r) => !r.ok)
    const installed = results.filter((r) => r.ok && !r.skipped)
    if (failed.length) {
      console.warn(`[fetch-infer] ${failed.length} variant(s) could not install`)
      if (failed.some((f) => f.id === 'linux-cuda' || f.id === 'win-cuda')) {
        console.warn(
          '[fetch-infer] NVIDIA CUDA prebuilds are often absent on bleeding-edge tags.\n' +
            '  Build from source: node scripts/build-infer-from-source.mjs <variant-id>'
        )
      }
    }
    console.log(`\n[fetch-infer] ${release.tag_name}: ${installed.length} variant(s) ready under dist/bin/`)
    if (failed.length && !installed.length) process.exit(1)
    return
  }

  if (variantArg) {
    const variant = resolveVariant(variantArg)
    assertHostOs(variant)
    await installInferVariant({ root, variant, release, force, cuda })
    console.log(`\n[fetch-infer] Done: ${release.tag_name} (${variant.id})`)
    return
  }

  if (process.platform === 'darwin') {
    await installLegacyDefault(release, cuda)
    console.log(`\n[fetch-infer] Done: ${release.tag_name}`)
    return
  }

  const ids = hostVariantIds()
  if (ids.length === 1) {
    const variant = resolveVariant(ids[0])
    await installInferVariant({ root, variant, release, force, cuda })
  } else if (ids.length > 1) {
    const primary = cpuOnly
      ? ids.find((id) => id.includes('vulkan')) ?? ids[0]
      : ids.find((id) => id.includes('cuda')) ?? ids[0]
    const variant = resolveVariant(primary)
    await installInferVariant({ root, variant, release, force, cuda })
    console.log(
      `[fetch-infer] Hint: cache all ${process.platform} variants with: node scripts/fetch-infer-binaries.mjs --all-host-variants`
    )
  } else {
    await installLegacyDefault(release, cuda)
  }

  console.log(`\n[fetch-infer] Done: ${release.tag_name}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
