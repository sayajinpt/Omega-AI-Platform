#!/usr/bin/env node
/**
 * Full Omega clean — ready for a fresh build from scratch.
 *
 * Removes (under the repo only — not %USERPROFILE%/.omega user data):
 *   - dist/ (binaries, staged Omega, NSIS installer, UI, runtime, engine)
 *   - repo .omega/ (llama-setup lock + llama.cpp source caches)
 *   - C++ CMake trees (runtime, shell, engine, engine/native)
 *   - synced llama.cpp under apps/engine/native/third_party
 *   - Content Studio .venv, __pycache__, *.egg-info, dev SQLite data/, prebuilt wheels
 *   - desktop / sdk compile outputs, Claw3D .next, pack staging
 *   - WebView2 user-data beside dist (Windows)
 *   - all workspace node_modules (unless --keep-node-modules)
 *
 * Usage:
 *   node scripts/clean-fresh.mjs
 *   node scripts/clean-fresh.mjs --dry-run
 *   node scripts/clean-fresh.mjs --keep-node-modules
 *   node scripts/clean-fresh.mjs --keep-llama-setup   # keep .omega/llama-setup.json (still drops caches)
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLAW3D_DEV_DIRS,
  CMAKE_BUILD_DIRS,
  DESKTOP_BUILD_DIRS,
  prepareWindowsClean,
  removeContentStudioDevArtifacts,
  removeDistOutputs,
  removeLlamaSyncedTree,
  removeRepoOmegaDir,
  removeStaleNodeModuleTrash
} from './lib/clean-artifacts.mjs'
import { removeAllNodeModules, removePath } from './lib/clean-workspace.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const keepNodeModules = process.argv.includes('--keep-node-modules')
const keepLlamaSetup = process.argv.includes('--keep-llama-setup')

const log = (msg) => console.log(msg)

const opts = { dryRun, log: (msg) => log(`[clean-fresh] ${msg}`) }

function remove(rel) {
  return removePath(root, rel, opts)
}

log('[clean-fresh] Omega full clean')
if (dryRun) log('[clean-fresh] dry-run — nothing will be deleted')

if (!dryRun) prepareWindowsClean(root)

log('[clean-fresh] — dist/ (installers, binaries, staged app)')
removeDistOutputs(root, opts)

log('[clean-fresh] — repo .omega (llama lock + source caches)')
removeRepoOmegaDir(root, { ...opts, keepLlamaSetup })

log('[clean-fresh] — llama.cpp synced tree')
removeLlamaSyncedTree(root, opts)

log('[clean-fresh] — native C++ CMake outputs')
for (const rel of CMAKE_BUILD_DIRS) remove(rel)

log('[clean-fresh] — Content Studio dev Python artifacts')
removeContentStudioDevArtifacts(root, opts)

log('[clean-fresh] — app compile & logs')
for (const rel of DESKTOP_BUILD_DIRS) remove(rel)
for (const rel of ['build-log.txt', 'npm-install-debug.txt']) remove(rel)

log('[clean-fresh] — Claw3D / pack staging')
for (const rel of CLAW3D_DEV_DIRS) remove(rel)

log('[clean-fresh] — stale node_modules rename trash')
removeStaleNodeModuleTrash(root, opts)

if (!keepNodeModules) {
  log('[clean-fresh] — npm workspace')
  removeAllNodeModules(root, opts)
} else {
  log('[clean-fresh] — skipped node_modules (--keep-node-modules)')
}

log('')
log('[clean-fresh] done.')
if (dryRun) {
  log('[clean-fresh] Re-run without --dry-run to apply.')
} else if (keepNodeModules) {
  log('[clean-fresh] Next: npm run build:win   (or build.bat)')
} else {
  log('[clean-fresh] Next: npm install  →  build.bat  (or npm run setup:llama && npm run build:win)')
}
