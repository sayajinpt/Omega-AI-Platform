#!/usr/bin/env node
/**
 * Make sure every llama.cpp backend prebuilt for this platform is present
 * before electron-builder packages the app. node-llama-cpp 3.x bundles CUDA
 * + Vulkan + CPU on Linux/Windows and Metal + CPU on macOS via the
 * @node-llama-cpp/* prebuilt sub-packages — they're normally pulled at install
 * time but we double-check here so the installer never ships an incomplete set.
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readPrimaryVariant } from './lib/llama-lock.mjs'
import { resolveLlamaCppSource } from './sync-llama-cpp.mjs'

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const nm = join(repoRoot, 'node_modules')

function platformBackends() {
  const p = process.platform
  const arch = process.arch
  const { variant } = readPrimaryVariant(repoRoot)
  if (variant?.gpu === 'cuda') return ['cuda']
  if (variant?.gpu === 'vulkan') return ['vulkan']

  if (p === 'darwin') return ['metal']
  if (p === 'win32' && arch === 'x64') return ['cuda', 'vulkan']
  if (p === 'linux' && arch === 'x64') return ['cuda', 'vulkan']
  if (p === 'linux' && arch === 'arm64') return ['vulkan']
  return []
}

function backendPackages(b) {
  // node-llama-cpp publishes per-backend prebuilds as @node-llama-cpp/<platform>-<arch>-<backend>
  const plat =
    process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (b === 'metal') return [`@node-llama-cpp/${plat}-${arch}`, `@node-llama-cpp/${plat}-${arch}-metal`]
  return [`@node-llama-cpp/${plat}-${arch}`, `@node-llama-cpp/${plat}-${arch}-${b}`]
}

function isInstalled(pkg) {
  const dir = join(nm, ...pkg.split('/'))
  if (!existsSync(dir)) return false
  // a prebuilt package should contain at least one .node binary
  try {
    const files = readdirSync(dir, { recursive: true })
    return files.some((f) => typeof f === 'string' && f.endsWith('.node'))
  } catch {
    return statSync(dir).isDirectory()
  }
}

const want = platformBackends()
const { variant: lockedVariant } = readPrimaryVariant(repoRoot)
if (lockedVariant) {
  console.log(`[ensure-backends] installer variant: ${lockedVariant.id} (${lockedVariant.gpu})`)
}
if (want.length === 0) {
  console.log(`[ensure-backends] no extra backends needed for ${process.platform}/${process.arch}`)
  process.exit(0)
}

const missing = []
for (const b of want) {
  for (const p of backendPackages(b)) {
    if (!isInstalled(p)) missing.push({ backend: b, pkg: p })
  }
}

if (missing.length === 0) {
  console.log(`[ensure-backends] all backends present: ${want.join(', ')}`)
  if (resolveLlamaCppSource(repoRoot)) {
    console.log(
      '[ensure-backends] local llama.cpp-b9247 detected — run: npx node-llama-cpp source build --gpu auto'
    )
    console.log(
      '  (after npm run sync:llama-cpp) to use MTP/speculative decoding in node-llama-cpp'
    )
  }
  process.exit(0)
}

console.log(`[ensure-backends] downloading missing prebuilts: ${missing.map((m) => m.pkg).join(', ')}`)
// Re-run node-llama-cpp's installer which fetches the right prebuilts for the
// current platform / arch / backend matrix.
try {
  execSync('npx --no-install node-llama-cpp source download --skipBuild --noUsageExample', {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_LLAMA_CPP_PREBUILT_DOWNLOAD: 'true' }
  })
} catch (e) {
  console.warn('[ensure-backends] source download failed — relying on already-installed prebuilts')
  console.warn(e?.message ?? e)
}

// Verify after install
let stillMissing = []
for (const m of missing) if (!isInstalled(m.pkg)) stillMissing.push(m)
if (stillMissing.length > 0) {
  console.warn(
    `[ensure-backends] WARNING: still missing after install: ${stillMissing.map((m) => `${m.backend}(${m.pkg})`).join(', ')}`
  )
  console.warn('[ensure-backends] The app will still run on the available backends.')
} else {
  console.log('[ensure-backends] all backends now present.')
}
