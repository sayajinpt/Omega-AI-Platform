#!/usr/bin/env node
/**
 * Build omega-runtime (C++ migration host) into dist/runtime/.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCmakePath, resolveWindowsCmakeConfigureArgs } from './lib/find-cmake.mjs'
import { stageVcRuntimeToDirs } from './lib/stage-vc-runtime.mjs'
import {
  clearIncompatibleWindowsCmakeCache,
  invalidateCmakeCacheIfSourceMoved
} from './lib/cmake-cache.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(root, 'apps', 'runtime')
const buildDir = join(runtimeDir, 'build')
const outDir = join(root, 'dist', 'runtime')
const exeName = process.platform === 'win32' ? 'omega-runtime.exe' : 'omega-runtime'
const outPath = join(outDir, exeName)
const catalogSrc = join(runtimeDir, 'resources', 'route-catalog.json')
const catalogOut = join(outDir, 'route-catalog.json')
const toolCatalogSrc = join(runtimeDir, 'resources', 'tool-catalog.json')
const toolCatalogOut = join(outDir, 'tool-catalog.json')
const winPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function withPwshShim(envBase = process.env) {
  if (process.platform !== 'win32') return envBase
  const pathVar = envBase.Path ?? envBase.PATH ?? ''
  if (pathVar.toLowerCase().includes('powershell\\7')) return envBase
  const shimDir = join(buildDir, '_cmd_shims')
  mkdirSync(shimDir, { recursive: true })
  const shimPath = join(shimDir, 'pwsh.cmd')
  writeFileSync(shimPath, `@echo off\r\n"${winPs}" %*\r\n`, 'utf8')
  return { ...envBase, Path: `${shimDir};${pathVar}` }
}

function findBuiltExe() {
  const candidates = [
    join(buildDir, 'Release', exeName),
    join(buildDir, 'Debug', exeName),
    join(buildDir, exeName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function syncRuntimeArtifacts() {
  if (existsSync(catalogSrc)) copyFileSync(catalogSrc, catalogOut)
  if (existsSync(toolCatalogSrc)) copyFileSync(toolCatalogSrc, toolCatalogOut)
  const pyRuntimeSrc = join(runtimeDir, 'resources', 'python-runtime')
  const pyRuntimeOut = join(outDir, 'python-runtime')
  if (existsSync(pyRuntimeSrc)) {
    cpSync(pyRuntimeSrc, pyRuntimeOut, { recursive: true })
  }
}

function runtimeSourcesNewerThanDist() {
  const markers = [
    join(runtimeDir, 'src', 'models', 'hf_client.cpp'),
    join(runtimeDir, 'CMakeLists.txt')
  ]
  if (!existsSync(outPath)) return true
  const builtAt = statSync(outPath).mtimeMs
  return markers.some((p) => existsSync(p) && statSync(p).mtimeMs > builtAt)
}

function useExistingRuntime(reason) {
  if (!existsSync(outPath)) return false
  console.warn(`[build-runtime] ${reason}`)
  console.warn(`[build-runtime] using existing ${outPath}`)
  if (runtimeSourcesNewerThanDist()) {
    console.warn(
      '[build-runtime] WARNING: apps/runtime C++ changed since this binary — Model Studio task filter and other runtime fixes need a successful rebuild.'
    )
  }
  syncRuntimeArtifacts()
  return true
}

const cmake = resolveCmakePath()
if (!cmake) {
  if (useExistingRuntime('cmake not found — rebuild skipped.')) process.exit(0)
  console.error(
    '[build-runtime] FATAL: cmake not found and no dist/runtime binary exists.',
    'Run build.bat from a Visual Studio Developer shell or install CMake, then retry.'
  )
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(buildDir, { recursive: true })

invalidateCmakeCacheIfSourceMoved(runtimeDir, buildDir, 'build-runtime')
clearIncompatibleWindowsCmakeCache(buildDir)

execSync('node scripts/generate-route-catalog.mjs', { cwd: root, stdio: 'inherit' })
execSync('node scripts/generate-tool-catalog.mjs', { cwd: root, stdio: 'inherit' })

const cmakeArgs = ['-S', runtimeDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', ...resolveWindowsCmakeConfigureArgs()]
console.log('[build-runtime] configuring with', cmake)
try {
  execSync(`"${cmake}" ${cmakeArgs.map((a) => `"${a}"`).join(' ')}`, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: withPwshShim()
  })
  execSync(`"${cmake}" --build "${buildDir}" --config Release`, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: withPwshShim()
  })
} catch (err) {
  if (useExistingRuntime('runtime rebuild failed — keeping previous dist/runtime.')) process.exit(0)
  throw err
}

const built = findBuiltExe()
if (!built) {
  if (useExistingRuntime('build finished but binary not found — keeping previous dist/runtime.')) process.exit(0)
  console.error('[build-runtime] build finished but binary not found under', buildDir)
  process.exit(1)
}

copyFileSync(built, outPath)
syncRuntimeArtifacts()
try {
  execSync(`chmod +x "${outPath}"`, { stdio: 'ignore' })
} catch {
  /* ignore */
}

if (process.platform === 'win32') {
  stageVcRuntimeToDirs([outDir], { required: true, label: 'build-runtime' })
}

console.log('[build-runtime] OK:', outPath)
