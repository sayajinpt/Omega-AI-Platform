#!/usr/bin/env node
/**
 * Build omega-runtime (C++ migration host) into dist/runtime/.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCmakePath } from './lib/find-cmake.mjs'
import { stageVcRuntimeToDirs } from './lib/stage-vc-runtime.mjs'
import { invalidateCmakeCacheIfSourceMoved } from './lib/cmake-cache.mjs'

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
  // vcpkg/msbuild tries `pwsh.exe`; provide a local shim for PS 5.1 hosts.
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

const cmake = resolveCmakePath()
if (!cmake) {
  console.error(
    '[build-runtime] FATAL: cmake not found — omega-runtime was NOT rebuilt.',
    'Install CMake and add it to PATH, then run build.bat again.',
    'Using a stale dist/runtime binary will ignore fixes in apps/runtime/.'
  )
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(buildDir, { recursive: true })

invalidateCmakeCacheIfSourceMoved(runtimeDir, buildDir, 'build-runtime')

execSync('node scripts/generate-route-catalog.mjs', { cwd: root, stdio: 'inherit' })
execSync('node scripts/generate-tool-catalog.mjs', { cwd: root, stdio: 'inherit' })

const cmakeArgs = ['-S', runtimeDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release']
console.log('[build-runtime] configuring with', cmake)
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

const built = findBuiltExe()
if (!built) {
  console.error('[build-runtime] build finished but binary not found under', buildDir)
  process.exit(1)
}

copyFileSync(built, outPath)
if (existsSync(catalogSrc)) copyFileSync(catalogSrc, catalogOut)
if (existsSync(toolCatalogSrc)) copyFileSync(toolCatalogSrc, toolCatalogOut)
const pyRuntimeSrc = join(runtimeDir, 'resources', 'python-runtime')
const pyRuntimeOut = join(outDir, 'python-runtime')
if (existsSync(pyRuntimeSrc)) {
  cpSync(pyRuntimeSrc, pyRuntimeOut, { recursive: true })
}
try {
  execSync(`chmod +x "${outPath}"`, { stdio: 'ignore' })
} catch {
  /* ignore */
}

if (process.platform === 'win32') {
  stageVcRuntimeToDirs([outDir], { required: true, label: 'build-runtime' })
}

console.log('[build-runtime] OK:', outPath)
