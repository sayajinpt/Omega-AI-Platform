#!/usr/bin/env node
/**
 * Interactive llama.cpp setup: latest GitHub release, pick variant(s),
 * download prebuilt binaries or build from source.
 *
 * Usage:
 *   node scripts/llama-setup.mjs
 *   node scripts/llama-setup.mjs --yes --mode=binary --variant=win-vulkan
 *   node scripts/llama-setup.mjs --tag=b9250 --mode=source --variant=win-cuda
 *   node scripts/llama-setup.mjs --mode=binary --all-host-variants   (CUDA + Vulkan for this OS)
 *   node scripts/llama-setup.mjs --installer   (build.bat: version + binary/source + one GPU)
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LLAMA_CPP_REPO_URL,
  ensureSourceTree,
  fetchRelease,
  normalizeTag,
  readSetupLock,
  writeSetupLock
} from './lib/llama-github.mjs'
import { confirm, pickMany, pickOne } from './lib/llama-prompt.mjs'
import { syncSourceIntoOmega } from './lib/llama-sync-core.mjs'
import {
  catalogReleaseAssets,
  installerHostVariantIds,
  printReleaseCatalog
} from './lib/llama-release-assets.mjs'
import {
  VARIANTS,
  assertHostOs,
  resolveVariant,
  variantsForInstaller
} from './lib/llama-variants.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const installerMode = process.argv.includes('--installer')
const nonInteractive = process.argv.includes('--yes') || process.argv.includes('-y')
const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]
const tagArg = process.argv.find((a) => a.startsWith('--tag='))?.split('=')[1]
const variantArgs = process.argv
  .filter((a) => a.startsWith('--variant='))
  .map((a) => a.split('=')[1])
const allHostVariantsFlag = process.argv.includes('--all-host-variants')

function hostVariants() {
  const host = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : null
  if (!host) return []
  return Object.values(VARIANTS).filter((v) => v.host === host)
}

async function resolveTag() {
  if (tagArg) return normalizeTag(tagArg)

  const lock = readSetupLock(root)
  let latest
  try {
    latest = await fetchRelease('latest', { root })
  } catch (err) {
    if (lock?.tag) {
      const locked = normalizeTag(lock.tag)
      console.warn(`[setup] GitHub releases API unavailable: ${err instanceof Error ? err.message : err}`)
      console.warn(`[setup] Using locked tag ${locked} from .omega/llama-setup.json`)
      return locked
    }
    throw err
  }

  if (nonInteractive) return normalizeTag(latest.tag_name)

  const title = installerMode ? 'Omega installer — llama.cpp' : 'Omega llama.cpp setup'
  console.log(`\n=== ${title} ===`)
  console.log(`Repository: ${LLAMA_CPP_REPO_URL}`)
  console.log(`Latest release: ${latest.tag_name} (${latest.published_at?.slice(0, 10) ?? 'unknown date'})`)
  if (lock?.tag) console.log(`Current lock: ${lock.tag}`)

  const tagChoice = await pickOne('Release version', [
    { value: 'latest', label: `Latest (${latest.tag_name})`, hint: 'recommended' },
    { value: 'custom', label: 'Enter a specific tag (e.g. b9247)' },
    ...(lock?.tag
      ? [{ value: lock.tag, label: `Keep locked tag (${lock.tag})` }]
      : [])
  ])

  if (tagChoice === 'custom') {
    const rl = await import('node:readline/promises')
    const { stdin, stdout } = await import('node:process')
    const iface = rl.createInterface({ input: stdin, output: stdout })
    const raw = (await iface.question('Tag name: ')).trim()
    iface.close()
    return normalizeTag(raw || latest.tag_name)
  }
  if (tagChoice === 'latest') return normalizeTag(latest.tag_name)
  return normalizeTag(tagChoice)
}

async function resolveMode() {
  if (modeArg) return modeArg
  if (nonInteractive) return 'binary'
  if (installerMode) {
    return pickOne('Inference binaries', [
      {
        value: 'binary',
        label: 'Use official prebuilt binaries from GitHub',
        hint: 'recommended — fast'
      },
      {
        value: 'source',
        label: 'Build from source on this PC',
        hint: 'slow — needs CUDA or Vulkan SDK'
      }
    ])
  }
  return pickOne('What do you want to do?', [
    {
      value: 'binary',
      label: 'Download official prebuilt binaries',
      hint: 'fast — omega-infer from GitHub releases'
    },
    {
      value: 'source',
      label: 'Build omega-engine from source',
      hint: 'slow — needs cmake and CUDA or Vulkan SDK'
    },
    {
      value: 'sync',
      label: 'Sync llama.cpp source only',
      hint: 'for native/runtime dev — no binary download or compile'
    },
    {
      value: 'full',
      label: 'Download binaries + build from source',
      hint: 'omega-infer zip + compile runtime and engine'
    }
  ])
}

async function resolveVariants() {
  const available = hostVariants()
  if (!available.length) {
    console.error(
      `[setup] Interactive variant pick is only supported on Windows and Linux (current: ${process.platform}).`
    )
    console.error('  Use --variant= on a supported host, or run setup on that OS.')
    process.exit(1)
  }

  if (variantArgs.length) {
    return variantArgs.map((id) => resolveVariant(id))
  }
  if (nonInteractive && available.length === 1) return available

  if (nonInteractive) {
    console.error('[setup] Non-interactive mode needs --variant=win-cuda (etc.)')
    process.exit(1)
  }

  if (installerMode) {
    const installerChoices = variantsForInstaller()
    if (!installerChoices.length) {
      console.error('[setup] Installer GPU pick requires Windows or Linux.')
      process.exit(1)
    }
    const id = await pickOne(
      'GPU variant for this installer',
      installerChoices.map((v) => ({
        value: v.id,
        label: v.label,
        hint:
          v.gpu === 'cuda'
            ? 'NVIDIA CUDA — GeForce / RTX'
            : 'Vulkan — AMD, Intel, or NVIDIA'
      }))
    )
    return [resolveVariant(id)]
  }

  const picked = await pickMany(
    `Select variant(s) for ${process.platform} (comma-separated numbers)`,
    available.map((v) => ({ value: v.id, label: v.label }))
  )
  return picked.map((id) => resolveVariant(id))
}

function run(cmd, label) {
  console.log(`\n[setup] === ${label} ===\n`)
  execSync(cmd, { cwd: root, stdio: 'inherit', env: process.env })
}

async function showReleaseCatalog(tag) {
  const release = await fetchRelease(tag === 'latest' ? 'latest' : tag, { root })
  const catalog = catalogReleaseAssets(release.assets ?? [], release.tag_name)
  const ids = installerMode ? installerHostVariantIds() : []
  printReleaseCatalog(catalog, ids.length ? { variantIds: ids } : {})
  return release.tag_name
}

function prefetchAllHostBinaries(tag, force) {
  const fetchFlags = ['--all-host-variants', `--tag=${tag}`, force ? '--force' : '']
    .filter(Boolean)
    .join(' ')
  run(`node scripts/fetch-infer-binaries.mjs ${fetchFlags}`, 'omega-infer (all host GPU variants)')
}

async function downloadBinaries(variant, tag, force, { skipInferFetch = false } = {}) {
  assertHostOs(variant)
  if (skipInferFetch) {
    console.log(`[setup] omega-infer for ${variant.id} already fetched (--all-host-variants)`)
    return
  }
  const fetchFlags = [`--variant=${variant.id}`, `--tag=${tag}`, force ? '--force' : '']
    .filter(Boolean)
    .join(' ')
  try {
    run(`node scripts/fetch-infer-binaries.mjs ${fetchFlags}`, `omega-infer (${variant.id})`)
  } catch (e) {
    console.warn(
      `[setup] Prebuilt fetch failed for ${variant.id} (${e?.message ?? e}) — building from source…`
    )
    run(
      `node scripts/build-infer-from-source.mjs ${variant.id}${force ? ' --force' : ''}`,
      `omega-infer source build (${variant.id})`
    )
  }
}

async function buildSource(variant, tag, safe) {
  assertHostOs(variant)
  process.env.LLAMA_CPP_TAG = tag
  process.env.OMEGA_LLAMA_VARIANT = variant.id
  if (safe) process.env.OMEGA_SAFE_BUILD = '1'
  run('node scripts/build-engine.mjs', `Build omega-engine (${variant.id})`)
}

function updateLock(tag, sourcePath, variantResults, primaryVariant) {
  const prev = readSetupLock(root) ?? { repo: 'ggml-org/llama.cpp', variants: {} }
  writeSetupLock(root, {
    ...prev,
    repo: 'ggml-org/llama.cpp',
    tag,
    sourcePath,
    primaryVariant,
    fetchedAt: new Date().toISOString(),
    variants: { ...prev.variants, ...variantResults }
  })
}

async function main() {
  const desktopPkg = join(root, 'apps', 'desktop', 'package.json')
  if (!existsSync(desktopPkg)) {
    console.error('[setup] Missing apps/desktop — Omega source tree is incomplete.')
    console.error('  Restore apps/desktop from your repo or backup, then run build.bat again.')
    process.exit(1)
  }

  if (installerMode && !process.stdin.isTTY) {
    console.error(
      '[setup] Interactive prompts need a real console (stdin must be a TTY).\n' +
        '  Run build.bat from Command Prompt or Windows Terminal, not from a piped/captured shell.'
    )
    process.exit(1)
  }

  const tag = await resolveTag()
  const mode = await resolveMode()
  const variants = await resolveVariants()
  const force = process.argv.includes('--force')
  const safe = process.argv.includes('--safe')

  console.log(`\n[setup] Tag: ${tag}`)
  console.log(`[setup] Mode: ${mode}`)
  console.log(`[setup] Variants: ${variants.map((v) => v.id).join(', ')}\n`)

  if (!nonInteractive) {
    const ok = await confirm('Continue?')
    if (!ok) {
      console.log('[setup] Cancelled.')
      return
    }
  }

  console.log(`[setup] Fetching source tree for ${tag}…`)
  const sourcePath = await ensureSourceTree(root, tag, { force })
  const { tag: syncedTag } = syncSourceIntoOmega(sourcePath, root, tag)
  run('node scripts/patch-llama-cpp-cmake.mjs', 'CMake patch')

  const needsBinaries = mode === 'binary' || mode === 'full'
  let prefetchedAllHost = false
  if (needsBinaries) {
    console.log('\n[setup] Checking latest llama.cpp prebuilt assets…')
    await showReleaseCatalog(syncedTag)
    const shouldPrefetchAll =
      allHostVariantsFlag ||
      (variants.length > 1 && variants.every((v) => v.host === variants[0].host))
    if (shouldPrefetchAll && hostVariants().length > 1) {
      prefetchAllHostBinaries(syncedTag, force)
      prefetchedAllHost = true
    }
  }

  const variantResults = {}

  for (const variant of variants) {
    const entry = { mode, tag: syncedTag }
    try {
      if (mode === 'sync') {
        entry.mode = 'sync'
      } else if (mode === 'binary') {
        await downloadBinaries(variant, syncedTag, force, { skipInferFetch: prefetchedAllHost })
        entry.inferDir = `dist/bin/${variant.inferSubdir}`
      } else if (mode === 'source') {
        await buildSource(variant, syncedTag, safe)
        entry.localBuild = true
      } else if (mode === 'full') {
        await downloadBinaries(variant, syncedTag, force, { skipInferFetch: prefetchedAllHost })
        await buildSource(variant, syncedTag, safe)
        entry.inferDir = `dist/bin/${variant.inferSubdir}`
        entry.localBuild = true
      }
      variantResults[variant.id] = entry
      console.log(`[setup] ✓ ${variant.id}`)
    } catch (e) {
      console.error(`[setup] ✗ ${variant.id}:`, e?.message ?? e)
      variantResults[variant.id] = { ...entry, error: String(e?.message ?? e) }
    }
  }

  const primaryVariant = variants.length === 1 ? variants[0].id : variants[variants.length - 1].id
  updateLock(syncedTag, sourcePath, variantResults, primaryVariant)

  console.log('\n[setup] Done.')
  console.log(`  Lock file: .omega/llama-setup.json`)
  console.log(`  Source cache: .omega/cache/llama.cpp-src/${syncedTag}`)
  console.log(`  Primary variant: ${primaryVariant}`)
  console.log(`  Dev: OMEGA_LLAMA_VARIANT=${primaryVariant}`)
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
