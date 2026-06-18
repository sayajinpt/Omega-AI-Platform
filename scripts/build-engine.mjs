#!/usr/bin/env node
/**
 * Build omega-engine (C++) into dist/engine/ for the current OS.
 * GPU backend follows llama-setup variant (.omega/llama-setup.json / OMEGA_LLAMA_VARIANT).
 * On Windows uses build-engine.ps1 (VS CMake + dev environment).
 */
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCmakePath } from './lib/find-cmake.mjs'
import { execPowerShellScript } from './lib/find-powershell.mjs'
import {
  resolveEngineGpuBuildOptions,
  buildCmakeGpuArgs,
  engineBuildCacheKey
} from './lib/engine-gpu-backend.mjs'
import { applyVulkanSdkToEnv } from './lib/vulkan-detect.mjs'
import { resolveEngineBuildDir, noteEngineBuildDir, invalidateEngineBuildCacheIfSourceMoved } from './lib/engine-build-dir.mjs'
import { stripDuplicateCudaRuntimeFromEngine, isCudaRuntimeDll, ensureCudaRuntimeInEngine } from './lib/cuda-runtime-shared.mjs'
import { stageVcRuntimeToDirs } from './lib/stage-vc-runtime.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(root, 'apps', 'engine')
const gpu = resolveEngineGpuBuildOptions(root)
const buildDirMeta = resolveEngineBuildDir(root, gpu)
const buildDir = buildDirMeta.dir
const outDir = join(root, 'dist', 'engine')
const exeName = process.platform === 'win32' ? 'omega-engine.exe' : 'omega-engine'
const outPath = join(outDir, exeName)
const nativeDir = join(root, 'apps', 'engine', 'native')

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

function copyEngineArtifacts(builtExe) {
  const srcDir = dirname(builtExe)
  copyFileSync(builtExe, outPath)
  if (process.platform === 'win32') {
    for (const name of readdirSync(srcDir)) {
      if (!name.toLowerCase().endsWith('.dll') || isCudaRuntimeDll(name)) continue
      copyFileSync(join(srcDir, name), join(outDir, name))
    }
    const inferLib = join(root, 'apps', 'engine', 'native', 'lib')
    if (existsSync(inferLib)) {
      for (const name of readdirSync(inferLib)) {
        if (name.toLowerCase().endsWith('.dll')) {
          const dest = join(outDir, name)
          if (!existsSync(dest)) {
            copyFileSync(join(inferLib, name), dest)
          }
        }
      }
    }
  }
}

function appendGpuCmakeArgs(cmakeArgs, gpu) {
  console.log(`[build-engine] GPU backend: ${gpu.reason}`)
  if (gpu.gpu === 'cpu' && gpu.variantId?.includes('vulkan')) {
    console.warn(
      '[build-engine] Vulkan variant without SDK — omega-engine will be CPU-only for GGUF inference.\n' +
        '  Install LunarG Vulkan SDK (https://vulkan.lunarg.com/) and rebuild for GPU layers in chat.'
    )
  } else if (gpu.gpu === 'cpu' && gpu.variantId?.includes('cuda')) {
    console.warn('[build-engine] CPU-only libomega_infer (variant or toolkit did not enable GPU)')
  }
  cmakeArgs.push(...buildCmakeGpuArgs(gpu))
}

function cmakeCacheMatchesGpu(gpu) {
  const cachePath = join(buildDir, 'CMakeCache.txt')
  if (!existsSync(cachePath)) return true
  const text = readFileSync(cachePath, 'utf8')
  const cacheVulkan = /(?:^|\n)GGML_VULKAN:BOOL=ON/m.test(text) || /(?:^|\n)OMEGA_GGML_VULKAN:BOOL=ON/m.test(text)
  const cacheCuda = /(?:^|\n)GGML_CUDA:BOOL=ON/m.test(text) || /(?:^|\n)OMEGA_GGML_CUDA:BOOL=ON/m.test(text)
  const cacheNative = /(?:^|\n)GGML_NATIVE:BOOL=ON/m.test(text)
  const cacheRepack = /(?:^|\n)GGML_CPU_REPACK:BOOL=ON/m.test(text)
  const cacheCudaArch = text.match(/(?:^|\n)CMAKE_CUDA_ARCHITECTURES:STRING=([^\n]+)/m)?.[1] ?? ''
  const cacheCudaArchOk =
    !gpu.enableCuda || (!cacheCudaArch.includes('75-virtual') && cacheCudaArch.includes('75-real'))
  return (
    gpu.enableVulkan === cacheVulkan &&
    gpu.enableCuda === cacheCuda &&
    !cacheNative &&
    !cacheRepack &&
    cacheCudaArchOk
  )
}

function invalidateEngineBuildCacheIfBackendChanged(gpu) {
  mkdirSync(buildDir, { recursive: true })
  const stampPath = join(buildDir, '.omega-gpu-backend')
  const key = engineBuildCacheKey(gpu)
  const cachePath = join(buildDir, 'CMakeCache.txt')
  let reason = ''
  if (existsSync(stampPath)) {
    const prev = readFileSync(stampPath, 'utf8').trim()
    if (prev !== key) reason = `GPU backend changed (${prev} → ${key})`
  }
  if (!reason && existsSync(cachePath) && !cmakeCacheMatchesGpu(gpu)) {
    reason = 'CMake GPU flags disagree with current variant/toolkit'
  }
  if (reason && existsSync(cachePath)) {
    console.log(`[build-engine] ${reason} — clearing CMake cache`)
    unlinkSync(cachePath)
  }
  writeFileSync(stampPath, `${key}\n`, 'utf8')
}

function buildEngineEnv(gpu) {
  const env = { ...process.env }
  env.OMEGA_NODE = process.execPath
  env.OMEGA_ENGINE_BUILD_DIR = buildDir
  if (gpu.enableCuda) env.OMEGA_GGML_CUDA = '1'
  else delete env.OMEGA_GGML_CUDA
  if (gpu.enableVulkan) env.OMEGA_GGML_VULKAN = '1'
  else delete env.OMEGA_GGML_VULKAN
  applyVulkanSdkToEnv(env, gpu.vulkanSdk)
  if (process.platform === 'win32') {
    ensureWindowsBuildPath(env, buildDir)
  }
  return env
}

function ensureWindowsBuildPath(env, engineBuildDir) {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows'
  const winPs = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const mustHave = [
    join(systemRoot, 'System32'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    join(systemRoot, 'System32', 'Wbem')
  ]
  const pathKey = Object.prototype.hasOwnProperty.call(env, 'Path') ? 'Path' : 'PATH'
  const parts = (env[pathKey] ?? '').split(';').filter(Boolean)
  const seen = new Set(parts.map((p) => p.toLowerCase()))
  if (existsSync(winPs)) {
    const shimDir = join(engineBuildDir, '_cmd_shims')
    mkdirSync(shimDir, { recursive: true })
    const shimBody = `@echo off\r\n"${winPs}" %*\r\n`
    writeFileSync(join(shimDir, 'pwsh.cmd'), shimBody, 'utf8')
    if (!seen.has(shimDir.toLowerCase())) {
      parts.unshift(shimDir)
      seen.add(shimDir.toLowerCase())
    }
  }
  for (const dir of mustHave) {
    if (!seen.has(dir.toLowerCase()) && existsSync(dir)) {
      parts.unshift(dir)
      seen.add(dir.toLowerCase())
    }
  }
  env[pathKey] = parts.join(';')
  if (pathKey === 'Path') env.PATH = env.Path
  else if (pathKey === 'PATH') env.Path = env.PATH
}

function resolveMsBuildParallel(gpu) {
  const raw = process.env.OMEGA_MSBUILD_PARALLEL?.trim()
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return gpu.enableCuda ? 1 : 0
}

function runCmakeBuild(buildDir, gpu, env) {
  const parallel = resolveMsBuildParallel(gpu)
  const parallelArg = parallel > 0 ? ` --parallel ${parallel}` : ''
  if (parallel > 0) {
    console.log(
      `[build-engine] MSBuild parallel jobs: ${parallel} (set OMEGA_MSBUILD_PARALLEL to override)`
    )
  }
  if (/\\Desktop\\|\\OneDrive\\/i.test(root)) {
    console.warn(
      '[build-engine] Project is under Desktop or OneDrive — cloud sync can lock build files. ' +
        'Vulkan builds use a short path under %LOCALAPPDATA%\\O\\eb-<repo-id> to avoid Windows MAX_PATH.'
    )
  }
  const cmd = `${cmake} --build "${buildDir}"${parallelArg}`.trim()
  const maxAttempts = gpu.enableCuda ? 3 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync(cmd, { cwd: root, stdio: 'inherit', shell: true, env })
      return
    } catch (e) {
      if (attempt >= maxAttempts) throw e
      console.warn(
        `[build-engine] build failed (attempt ${attempt}/${maxAttempts}), retrying in 5s…`
      )
      console.warn(
        '[build-engine] tip: close other MSBuild/nvcc processes; pause antivirus on apps/engine/build'
      )
      execSync('ping -n 6 127.0.0.1 >nul', { stdio: 'ignore', shell: true })
    }
  }
}

function verifyVulkanShaderEmbeds(buildDir, gpu) {
  if (!gpu?.enableVulkan) return
  const vkDir = join(buildDir, 'omega_infer_build', 'llama_cpp_build', 'ggml', 'src', 'ggml-vulkan')
  const unaryCpp = join(vkDir, 'unary.comp.cpp')
  if (!existsSync(unaryCpp)) {
    console.warn(`[build-engine] Vulkan verify: missing ${unaryCpp}`)
    return
  }
  const { size } = statSync(unaryCpp)
  if (size < 4096) {
    console.error(
      `[build-engine] Vulkan verify FAILED: unary.comp.cpp is ${size} bytes (expected ~900KB). ` +
        'All glslc compiles failed — omega_infer.dll will crash on GPU load. ' +
        'Check VULKAN_SDK / glslc on PATH during build.'
    )
    process.exit(1)
  }
  console.log(`[build-engine] Vulkan verify OK: unary.comp.cpp ${Math.round(size / 1024)} KB`)
}

function applyCudaRuntimeSharing() {
  const cudaDedupe = stripDuplicateCudaRuntimeFromEngine(root)
  if (cudaDedupe.removed.length) {
    console.log(
      `[build-engine] shared CUDA runtime in dist/bin only — removed from dist/engine/: ${cudaDedupe.removed.join(', ')} (~${cudaDedupe.freedMb} MB)`
    )
  }
  if (process.platform === 'win32') {
    const cuda = ensureCudaRuntimeInEngine(join(root, 'dist', 'engine'), join(root, 'dist', 'bin'))
    if (cuda.hard.linked.length) {
      console.log(`[build-engine] CUDA runtime hard-linked into dist/engine/: ${cuda.hard.linked.join(', ')}`)
    }
    if (cuda.copy.copied.length) {
      console.log(`[build-engine] CUDA runtime copied into dist/engine/: ${cuda.copy.copied.join(', ')}`)
    }
    const linkErrors = cuda.hard.errors
    if (linkErrors.length) {
      console.warn(
        `[build-engine] CUDA hard-link warnings: ${linkErrors.map((e) => `${e.name}: ${e.message}`).join('; ')}`
      )
    }
    if (cuda.copy.errors.length) {
      console.warn(
        `[build-engine] CUDA copy warnings: ${cuda.copy.errors.map((e) => `${e.name}: ${e.message}`).join('; ')}`
      )
    }
  }
}

invalidateEngineBuildCacheIfSourceMoved(root, buildDir)
invalidateEngineBuildCacheIfBackendChanged(gpu)
if (buildDirMeta.short) {
  console.log(`[build-engine] build dir: ${buildDir} (${buildDirMeta.reason})`)
  noteEngineBuildDir(root, buildDir, buildDirMeta)
} else {
  console.log(`[build-engine] build dir: ${buildDir}`)
}

if (process.platform === 'win32') {
  const cmake = resolveCmakePath()
  if (!cmake) {
    console.warn('[build-engine] cmake not found (checked PATH, OMEGA_CMAKE, Visual Studio) — skipping.')
    if (!existsSync(outPath)) {
      console.warn('[build-engine] No existing binary at', outPath)
      process.exit(0)
    }
    console.log('[build-engine] Using existing', outPath)
    process.exit(0)
  }
  console.log('[build-engine] Windows: using VS toolchain via build-engine.ps1')
  console.log('[build-engine] CMake:', cmake)
  const ps1 = join(root, 'scripts', 'build-engine.ps1')
  const env = buildEngineEnv(gpu)
  env.OMEGA_CMAKE = cmake
  execPowerShellScript(ps1, [], { cwd: root, stdio: 'inherit', env })
  if (!existsSync(outPath)) {
    console.error('[build-engine] expected output missing:', outPath)
    process.exit(1)
  }
  applyCudaRuntimeSharing()
  if (process.platform === 'win32') {
    stageVcRuntimeToDirs([outDir], { required: true, label: 'build-engine' })
  }
  verifyVulkanShaderEmbeds(buildDir, gpu)
  console.log('[build-engine] OK:', outPath)
  process.exit(0)
}

const cmake = resolveCmakePath()
if (!cmake) {
  console.warn('[build-engine] cmake not found — skipping omega-engine build.')
  if (!existsSync(outPath)) {
    console.warn('[build-engine] No existing binary at', outPath)
    process.exit(0)
  }
  console.log('[build-engine] Using existing', outPath)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(buildDir, { recursive: true })

const linkInfer =
  process.env.OMEGA_ENGINE_LINK_INFER === '1' ||
  existsSync(join(nativeDir, 'CMakeLists.txt'))

const cmakeArgs = ['-S', engineDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release']
if (linkInfer) {
  cmakeArgs.push('-DOMEGA_ENGINE_LINK_INFER=ON')
  console.log('[build-engine] linking libomega_infer')
  appendGpuCmakeArgs(cmakeArgs, gpu)
}

console.log('[build-engine] configuring', buildDir, 'with', cmake)
execSync(`${cmake} ${cmakeArgs.map((a) => `"${a}"`).join(' ')}`, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: buildEngineEnv(gpu)
})

runCmakeBuild(buildDir, gpu, buildEngineEnv(gpu))

const built = findBuiltExe()
if (!built) {
  console.error('[build-engine] build finished but binary not found under', buildDir)
  process.exit(1)
}

copyEngineArtifacts(built)
applyCudaRuntimeSharing()
if (process.platform === 'win32') {
  stageVcRuntimeToDirs([outDir], { required: true, label: 'build-engine' })
}
verifyVulkanShaderEmbeds(buildDir, gpu)
try {
  execSync(`chmod +x "${outPath}"`, { stdio: 'ignore' })
} catch {
  /* ignore */
}

console.log('[build-engine] OK:', outPath)
