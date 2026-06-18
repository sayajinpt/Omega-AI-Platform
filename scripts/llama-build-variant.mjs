#!/usr/bin/env node
/**
 * Dev-only: fetch omega-infer + optionally build runtime/engine for one GPU variant.
 * For production installers use build.bat (Windows) or build.sh (Linux).
 *
 * Usage: node scripts/llama-build-variant.mjs win-cuda [--prebuilt-only] [--force]
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertHostOs, resolveVariant } from './lib/llama-variants.mjs'
import { resolveLlamaCppSource } from './sync-llama-cpp.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const flags = process.argv.slice(2).filter((a) => a.startsWith('-'))
const variantId = args[0] ?? process.env.OMEGA_LLAMA_VARIANT
const prebuiltOnly = flags.includes('--prebuilt-only')
const skipSource = flags.includes('--skip-source') || prebuiltOnly
const safeSource = flags.includes('--safe')
const forceFetch = flags.includes('--force')

if (!variantId) {
  console.error(
    'Usage: node scripts/llama-build-variant.mjs <variant-id> [--prebuilt-only] [--force]\n' +
      '  Variants: win-cuda, win-vulkan, linux-cuda, linux-vulkan, …'
  )
  process.exit(1)
}

const variant = resolveVariant(variantId)
assertHostOs(variant)

function run(cmd, label) {
  console.log(`\n[llama-variant] === ${label} ===\n`)
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, OMEGA_LLAMA_VARIANT: variant.id } })
}

console.log(`\n[llama-variant] ${variant.label} (${variant.id})\n`)

const syncCmd = resolveLlamaCppSource(root)
  ? 'node scripts/sync-llama-cpp.mjs'
  : 'node scripts/sync-llama-cpp.mjs --fetch'
run(syncCmd, 'Sync llama.cpp')
run('node scripts/patch-llama-cpp-cmake.mjs', 'Patch CMake (stable MSBuild)')

const fetchFlags = [`--variant=${variant.id}`, forceFetch ? '--force' : ''].filter(Boolean).join(' ')
run(`node scripts/fetch-infer-binaries.mjs ${fetchFlags}`, `Fetch omega-infer (${variant.gpu})`)

if (!skipSource) {
  if (safeSource) process.env.OMEGA_SAFE_BUILD = '1'
  run('node scripts/build-engine.mjs', `Build omega-engine (${variant.gpu})`)
} else {
  console.log('\n[llama-variant] Skipped source build (--prebuilt-only). Using GitHub omega-infer binaries.\n')
}

console.log(`\n[llama-variant] Done: ${variant.id}`)
console.log(`  omega-infer: dist/bin/${variant.inferSubdir}/`)
console.log(`  In dev, set: OMEGA_LLAMA_VARIANT=${variant.id}`)
if (!skipSource) {
  console.log('  omega-engine: dist/engine/')
}
console.log('')
