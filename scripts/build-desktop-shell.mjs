#!/usr/bin/env node
/**
 * Build omega-desktop native shell into dist/shell/.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { resolveCmakePath } from './lib/find-cmake.mjs'
import { ensureCudaRuntimeInEngine } from './lib/cuda-runtime-shared.mjs'
import { stageVcRuntimeToDirs } from './lib/stage-vc-runtime.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = join(root, 'apps', 'shell')
const buildDir = join(shellDir, 'build')
const outDir = join(root, 'dist', 'shell')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const runtimeName = isWin ? 'omega-runtime.exe' : 'omega-runtime'
const engineName = isWin ? 'omega-engine.exe' : 'omega-engine'

function shellBinaryName() {
  if (isWin) return 'omega-desktop.exe'
  if (isMac) return join('omega-desktop.app', 'Contents', 'MacOS', 'omega-desktop')
  return 'omega-desktop'
}

function findBuiltBinary() {
  if (isMac) {
    const bundles = [
      join(buildDir, 'Release', 'omega-desktop.app'),
      join(buildDir, 'omega-desktop.app')
    ]
    for (const p of bundles) {
      if (existsSync(p)) return p
    }
    return null
  }
  const name = isWin ? 'omega-desktop.exe' : 'omega-desktop'
  const candidates = [
    join(buildDir, 'Release', name),
    join(buildDir, 'Debug', name),
    join(buildDir, name)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

if (isWin) {
  execSync('node scripts/fetch-webview2-sdk.mjs', { cwd: root, stdio: 'inherit' })
  execSync('node scripts/ensure-app-icon.mjs', { cwd: root, stdio: 'inherit' })
}

const uiDir = join(root, 'dist', 'ui')
if (!existsSync(join(uiDir, 'index.html')) && !existsSync(join(uiDir, 'index.native.html'))) {
  console.warn('[build-desktop-shell] dist/ui missing — run: npm run build:ui')
}

const runtimeExe = join(root, 'dist', 'runtime', runtimeName)
if (!existsSync(runtimeExe)) {
  console.error(`[build-desktop-shell] dist/runtime/${runtimeName} missing — run: npm run build:runtime`)
  process.exit(1)
}

const cmake = resolveCmakePath()
if (!cmake) {
  console.error('[build-desktop-shell] cmake not found')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(buildDir, { recursive: true })

const cmakeArgs = ['-S', shellDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release']
if (isWin) cmakeArgs.push('-A', 'x64')
console.log('[build-desktop-shell] configuring for', process.platform)
execSync(`"${cmake}" ${cmakeArgs.map((a) => `"${a}"`).join(' ')}`, {
  cwd: root,
  stdio: 'inherit',
  shell: true
})

const buildCmd = isWin
  ? `"${cmake}" --build "${buildDir}" --config Release`
  : `"${cmake}" --build "${buildDir}" --config Release -j ${Math.max(2, os.cpus().length)}`
execSync(buildCmd, { cwd: root, stdio: 'inherit', shell: true })

const built = findBuiltBinary()
if (!built) {
  console.error('[build-desktop-shell] binary not found under', buildDir)
  process.exit(1)
}

if (isMac) {
  cpSync(built, join(outDir, 'omega-desktop.app'), { recursive: true })
} else if (isWin) {
  copyFileSync(built, join(outDir, 'omega-desktop.exe'))
} else {
  copyFileSync(built, join(outDir, 'omega-desktop'))
  try {
    execSync(`chmod +x "${join(outDir, 'omega-desktop')}"`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

if (existsSync(uiDir)) {
  const shellUi = join(outDir, 'ui')
  if (existsSync(shellUi)) rmSync(shellUi, { recursive: true, force: true })
  cpSync(uiDir, shellUi, { recursive: true })
  for (const page of ['index.native.html', 'avatar-monitor.html', 'screen-snip.html']) {
    const src = join(outDir, 'ui', page)
    if (!existsSync(src)) continue
    const base = page === 'index.native.html' ? 'index.html' : page
    copyFileSync(src, join(outDir, 'ui', base))
  }
}

if (existsSync(runtimeExe)) {
  mkdirSync(join(outDir, 'runtime'), { recursive: true })
  copyFileSync(runtimeExe, join(outDir, 'runtime', runtimeName))
  for (const extra of ['route-catalog.json', 'tool-catalog.json']) {
    const src = join(root, 'dist', 'runtime', extra)
    if (existsSync(src)) copyFileSync(src, join(outDir, 'runtime', extra))
  }
  const pyRuntimeSrc = join(root, 'dist', 'runtime', 'python-runtime')
  if (existsSync(pyRuntimeSrc)) {
    cpSync(pyRuntimeSrc, join(outDir, 'runtime', 'python-runtime'), { recursive: true })
  }
}

const engineExe = join(root, 'dist', 'engine', engineName)
if (existsSync(engineExe)) {
  mkdirSync(join(outDir, 'engine'), { recursive: true })
  cpSync(join(root, 'dist', 'engine'), join(outDir, 'engine'), { recursive: true })
}

const binDir = join(root, 'dist', 'bin')
if (existsSync(binDir)) {
  cpSync(binDir, join(outDir, 'bin'), { recursive: true })
}

const stagedEngine = join(outDir, 'engine')
const stagedBin = join(outDir, 'bin')
if (existsSync(stagedEngine) && existsSync(stagedBin)) {
  const cuda = ensureCudaRuntimeInEngine(stagedEngine, stagedBin)
  if (cuda.hard.linked.length) {
    console.log('[build-desktop-shell] CUDA runtime hard-linked into engine/:', cuda.hard.linked.join(', '))
  }
  if (cuda.copy.copied.length) {
    console.log('[build-desktop-shell] CUDA runtime copied into engine/:', cuda.copy.copied.join(', '))
  }
}

if (isWin) {
  stageVcRuntimeToDirs([outDir, join(outDir, 'runtime'), join(outDir, 'engine')], {
    required: true,
    label: 'build-desktop-shell'
  })
}

console.log('[build-desktop-shell] OK:', outDir)
