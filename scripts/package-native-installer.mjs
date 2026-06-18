#!/usr/bin/env node
/**
 * Build NSIS installer for dist/native/Omega.
 * Uses makensis on PATH, NSIS_HOME, or standard Windows install dirs.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pruneNativeInstallerPayload } from './lib/prune-installer-bin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const payload = join(root, 'dist', 'native', 'Omega')
const nsi = join(root, 'scripts', 'native-installer.nsi')

if (!existsSync(join(payload, 'omega-desktop.exe'))) {
  console.error('[package-native-installer] missing dist/native/Omega — run: npm run build:shell')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.1.0'
const out = join(root, 'dist', 'native', `Omega-${version}-Setup.exe`)

function resolveMakensis() {
  const candidates = [
    process.env.NSIS_HOME ? join(process.env.NSIS_HOME, 'makensis.exe') : null,
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
    'makensis'
  ].filter(Boolean)

  for (const exe of candidates) {
    if (exe !== 'makensis' && !existsSync(exe)) continue
    const probe = spawnSync(exe, ['/VERSION'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return exe
  }
  return null
}

const makensisExe = resolveMakensis()
if (!makensisExe) {
  console.warn('[package-native-installer] makensis not found — skip NSIS')
  console.warn('[package-native-installer] install NSIS or set NSIS_HOME (e.g. C:\\Program Files (x86)\\NSIS)')
  console.warn('[package-native-installer] staged app folder: dist/native/Omega')
  process.exit(0)
}

console.log('[package-native-installer] using', makensisExe)

pruneNativeInstallerPayload(root)

execFileSync(makensisExe, [`/DPRODUCT_VERSION=${version}`, nsi], { stdio: 'inherit', cwd: root })

if (!existsSync(out)) {
  console.error('[package-native-installer] makensis finished but installer missing:', out)
  process.exit(1)
}

console.log('[package-native-installer] OK:', out)
