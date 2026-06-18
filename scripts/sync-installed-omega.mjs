#!/usr/bin/env node
/**
 * Copy freshly built runtime into an existing Omega install under %LOCALAPPDATA%\Programs\Omega.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeBuildTag } from './lib/verify-packaged-runtime.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeName = process.platform === 'win32' ? 'omega-runtime.exe' : 'omega-runtime'
const staged = join(root, 'dist', 'native', 'Omega')
const stagedRuntime = join(staged, 'runtime', runtimeName)
const installDir = process.env.OMEGA_INSTALL_DIR
  ? process.env.OMEGA_INSTALL_DIR
  : join(process.env.LOCALAPPDATA || '', 'Programs', 'Omega')
const installRuntime = join(installDir, 'runtime', runtimeName)

if (!existsSync(stagedRuntime)) {
  console.error('[sync-installed] missing staged runtime:', stagedRuntime)
  console.error('[sync-installed] run: npm run build:shell')
  process.exit(1)
}
if (!existsSync(installDir)) {
  console.log('[sync-installed] no install at', installDir, '— nothing to sync')
  process.exit(0)
}

mkdirSync(join(installDir, 'runtime'), { recursive: true })
copyFileSync(stagedRuntime, installRuntime)
for (const extra of ['route-catalog.json', 'tool-catalog.json']) {
  const src = join(staged, 'runtime', extra)
  if (existsSync(src)) copyFileSync(src, join(installDir, 'runtime', extra))
}
const pySrc = join(staged, 'runtime', 'python-runtime')
if (existsSync(pySrc)) {
  cpSync(pySrc, join(installDir, 'runtime', 'python-runtime'), { recursive: true })
}
const desktopExe = join(staged, process.platform === 'win32' ? 'omega-desktop.exe' : 'omega-desktop')
if (existsSync(desktopExe)) {
  copyFileSync(desktopExe, join(installDir, process.platform === 'win32' ? 'omega-desktop.exe' : 'omega-desktop'))
}

const tag = readRuntimeBuildTag(installRuntime)
console.log('[sync-installed] updated', installRuntime)
console.log('[sync-installed] build_tag:', tag ?? '(none)')
