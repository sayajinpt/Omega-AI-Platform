#!/usr/bin/env node
/**
 * Stage full Omega native desktop layout under dist/native/ (WebView2 shell, no Electron).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { verifyPackagedRuntime } from './lib/verify-packaged-runtime.mjs'
import { fileURLToPath } from 'node:url'
import { copyForInstallerPack, pruneNativeInstallerPayload } from './lib/prune-installer-bin.mjs'
import { ensureCudaRuntimeInEngine } from './lib/cuda-runtime-shared.mjs'
import { stageClaw3dOffice } from './lib/stage-claw3d-resources.mjs'
import { stageVcRuntimeToDirs, writeInstallManifest } from './lib/stage-vc-runtime.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellSrc = join(root, 'dist', 'shell')
const outRoot = join(root, 'dist', 'native', 'Omega')

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false
  copyForInstallerPack(src, dest)
  return true
}

if (!existsSync(join(shellSrc, 'omega-desktop.exe'))) {
  console.error('[package-native] missing dist/shell/omega-desktop.exe — run: npm run build:shell')
  process.exit(1)
}

if (existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

copyForInstallerPack(shellSrc, outRoot)

const runtimeName = process.platform === 'win32' ? 'omega-runtime.exe' : 'omega-runtime'
const runtimeSrc = join(root, 'dist', 'runtime', runtimeName)
if (!existsSync(runtimeSrc)) {
  console.error('[package-native] missing dist/runtime/' + runtimeName + ' — run: npm run build:runtime')
  process.exit(1)
}
const runtimeDestDir = join(outRoot, 'runtime')
mkdirSync(runtimeDestDir, { recursive: true })
copyFileSync(runtimeSrc, join(runtimeDestDir, runtimeName))
for (const extra of ['route-catalog.json', 'tool-catalog.json']) {
  const src = join(root, 'dist', 'runtime', extra)
  if (existsSync(src)) copyFileSync(src, join(runtimeDestDir, extra))
}
const pyRuntimeSrc = join(root, 'dist', 'runtime', 'python-runtime')
if (existsSync(pyRuntimeSrc)) {
  cpSync(pyRuntimeSrc, join(runtimeDestDir, 'python-runtime'), { recursive: true })
}

const resources = join(outRoot, 'resources')
mkdirSync(resources, { recursive: true })

copyIfExists(join(root, 'dist', 'content-studio'), join(resources, 'content-studio'))
copyIfExists(join(root, 'apps', 'desktop', 'content-studio'), join(resources, 'content-studio'))

try {
  stageClaw3dOffice(root, resources)
} catch (e) {
  console.error('[package-native]', e instanceof Error ? e.message : String(e))
  process.exit(1)
}

copyIfExists(join(root, 'engines'), join(resources, 'engines'))
copyIfExists(join(root, 'apps', 'desktop', 'scripts'), join(resources, 'scripts'))

const icon = join(root, 'apps', 'desktop', 'resources', 'icon.png')
const iconIco = join(root, 'apps', 'desktop', 'resources', 'icon.ico')
if (existsSync(icon)) copyFileSync(icon, join(outRoot, 'ui', 'icon.png'))
if (existsSync(iconIco)) copyFileSync(iconIco, join(outRoot, 'icon.ico'))

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.1.0'
writeFileSync(join(outRoot, 'VERSION'), version + '\n', 'utf8')
writeFileSync(join(outRoot, 'runtime', 'VERSION'), version + '\n', 'utf8')

const vc = stageVcRuntimeToDirs(
  [outRoot, join(outRoot, 'runtime'), join(outRoot, 'engine')],
  { required: true, label: 'package-native' }
)
writeInstallManifest(outRoot, vc)

pruneNativeInstallerPayload(root)

const stagedEngine = join(outRoot, 'engine')
const stagedBin = join(outRoot, 'bin')
if (existsSync(stagedEngine) && existsSync(stagedBin)) {
  const cuda = ensureCudaRuntimeInEngine(stagedEngine, stagedBin)
  if (cuda.hard.linked.length) {
    console.log('[package-native] CUDA runtime hard-linked into engine/:', cuda.hard.linked.join(', '))
  }
  if (cuda.copy.copied.length) {
    console.log('[package-native] CUDA runtime copied into engine/:', cuda.copy.copied.join(', '))
  }
  if (cuda.hard.errors.length || cuda.copy.errors.length) {
    for (const e of [...cuda.hard.errors, ...cuda.copy.errors]) {
      console.warn('[package-native] CUDA runtime staging:', e.name, e.message)
    }
  }
}

const verified = verifyPackagedRuntime(root, { destPath: join(outRoot, 'runtime', runtimeName) })
console.log('[package-native] runtime build_tag:', verified.destTag ?? '(none)')
console.log('[package-native] OK:', outRoot)
