#!/usr/bin/env node
/**
 * Windows/Linux prebuild: sync llama.cpp, fetch omega-infer for locked variant,
 * promote binaries to dist/bin root for the installer, prune duplicate variant dirs.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { readPrimaryVariant } from './lib/llama-lock.mjs'
import { fetchRelease, writeSetupLock } from './lib/llama-github.mjs'
import { detectInstalledCuda } from './lib/cuda-detect.mjs'
import { installAllHostVariants, installInferVariant } from './lib/fetch-infer-install.mjs'
import { installerHostVariantIds } from './lib/llama-release-assets.mjs'
import { resolveVariant } from './lib/llama-variants.mjs'
import { pruneInstallerBin } from './lib/prune-installer-bin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skipFetch = process.argv.includes('--skip-fetch')
const forceFetch = process.argv.includes('--force-fetch')
const fetchAllVariants = process.argv.includes('--fetch-all-variants')
const host = process.platform

function inferNames() {
  if (host === 'win32') {
    return { server: 'omega-infer.exe', quant: 'llama-quantize.exe' }
  }
  return { server: 'omega-infer', quant: 'llama-quantize' }
}

function inferServerPath(variant) {
  return join(root, 'dist', 'bin', variant.inferSubdir, inferNames().server)
}

function inferVariantReady(variant) {
  const names = inferNames()
  const binDir = join(root, 'dist', 'bin', variant.inferSubdir)
  return existsSync(join(binDir, names.server)) && existsSync(join(binDir, names.quant))
}

function run(cmd, label, { allowMissingOnCrash = false, variant } = {}) {
  console.log(`[prebuild:llama] ${label}`)
  try {
    execSync(cmd, { cwd: root, stdio: 'inherit', env: process.env })
  } catch (err) {
    const status = err && typeof err === 'object' && 'status' in err ? err.status : null
    const crashed = status === 3221226505 || status === -1073740791
    if (allowMissingOnCrash && variant && existsSync(inferServerPath(variant))) {
      console.warn(
        `[prebuild:llama] subprocess exited (${status ?? 'error'}) but infer binary exists — continuing`
      )
      return
    }
    if (crashed) {
      throw new Error(
        `${label} crashed (exit ${status}). Close Omega/Cursor, run build.bat from Explorer, retry.`
      )
    }
    throw err
  }
}

function copyDirFlat(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, name), join(destDir, name))
  }
}

function promoteInferToRoot(variant) {
  const srcDir = join(root, 'dist', 'bin', variant.inferSubdir)
  const destDir = join(root, 'dist', 'bin')
  if (!existsSync(srcDir)) {
    console.warn(`[prebuild:llama] variant dir missing: ${srcDir} — run build.bat / build.sh or npm run setup:llama`)
    return false
  }
  copyDirFlat(srcDir, destDir)
  console.log(`[prebuild:llama] promoted ${variant.id} binaries → dist/bin/ (installer root)`)
  return true
}

function writeBuildManifest(variant, tag) {
  const cuda = variant.gpu === 'cuda' ? detectInstalledCuda() : null
  const manifest = {
    variant: variant.id,
    gpu: variant.gpu,
    tag: tag ?? null,
    cudaMajor: cuda?.major === 12 || cuda?.major === 13 ? cuda.major : null,
    builtAt: new Date().toISOString()
  }
  const distPath = join(root, 'dist', 'llama-build.json')
  mkdirSync(dirname(distPath), { recursive: true })
  writeFileSync(distPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[prebuild:llama] wrote ${distPath}`)
}

async function fetchInferIfNeeded(variant, tag) {
  const normTag = tag ?? 'latest'

  if (fetchAllVariants) {
    const ids = installerHostVariantIds()
    const missing = forceFetch ? ids : ids.filter((id) => !inferVariantReady(resolveVariant(id)))
    if (!missing.length) {
      console.log('[prebuild:llama] all host omega-infer variants already present — skipping fetch')
      return
    }
    console.log(`[prebuild:llama] fetch omega-infer (${missing.length} host variant(s), ${normTag})`)
    const release = await fetchRelease(normTag, { root })
    await installAllHostVariants({ root, release, variantIds: missing, force: forceFetch })
    return
  }

  if (!forceFetch && inferVariantReady(variant)) {
    console.log(`[prebuild:llama] omega-infer already present (${variant.id}) — skipping fetch`)
    return
  }

  console.log(`[prebuild:llama] fetch omega-infer (${variant.id}, ${normTag})`)
  const release = await fetchRelease(normTag, { root })
  await installInferVariant({
    root,
    variant,
    release,
    force: forceFetch,
    cuda: detectInstalledCuda()
  })
}

async function main() {
  if (host !== 'win32' && host !== 'linux') {
    console.error('[prebuild:llama] Windows or Linux only')
    process.exit(1)
  }

  const { lock, variant, tag } = readPrimaryVariant(root)
  if (!variant) {
    const hint = host === 'win32' ? 'build.bat' : 'build.sh'
    console.error(
      `[prebuild:llama] No llama variant in .omega/llama-setup.json.\n` +
        `  Run ${hint} (interactive setup) or: npm run setup:llama -- --installer`
    )
    process.exit(1)
  }

  process.env.OMEGA_LLAMA_VARIANT = variant.id
  console.log(`[prebuild:llama] variant=${variant.id} tag=${tag ?? '(from sync)'}`)

  run('node scripts/sync-llama-cpp.mjs', 'sync llama.cpp')

  if (!skipFetch) {
    try {
      await fetchInferIfNeeded(variant, tag)
    } catch (err) {
      if (inferVariantReady(variant)) {
        console.warn(
          `[prebuild:llama] fetch failed (${err instanceof Error ? err.message : err}) but ${variant.id} binaries exist — continuing`
        )
      } else {
        throw err
      }
    }
  }

  promoteInferToRoot(variant)
  const pruned = pruneInstallerBin(root)
  if (pruned.removed.length) {
    console.log(
      `[prebuild:llama] pruned dist/bin for installer: ${pruned.removed.join(', ')} (${pruned.beforeMb} MB → ${pruned.afterMb} MB)`
    )
  }
  writeBuildManifest(variant, tag)

  if (lock) {
    writeSetupLock(root, { ...lock, primaryVariant: variant.id })
  }

  run('node scripts/build-engine.mjs', 'build omega-engine')
  const engineExe = join(root, 'dist', 'engine', host === 'win32' ? 'omega-engine.exe' : 'omega-engine')
  if (!existsSync(engineExe)) {
    console.error(
      `[prebuild:llama] omega-engine missing at ${engineExe} — install cmake and rebuild (required; node-llama-cpp was removed)`
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
