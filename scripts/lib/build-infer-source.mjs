/**
 * Build llama-server + llama-quantize from synced source when GitHub prebuilts are absent.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveCmakePath } from './find-cmake.mjs'
import { patchLlamaCppCmakeGitDepends } from './llama-sync-core.mjs'
import { llamaStandaloneCmakeArgs, resolveInferSourceGpuOptions } from './infer-source-cmake-args.mjs'
import { applyVulkanSdkToEnv } from './vulkan-detect.mjs'
import { execPowerShellScript } from './find-powershell.mjs'

function namesForHost() {
  if (process.platform === 'win32') {
    return {
      server: 'llama-server.exe',
      quant: 'llama-quantize.exe',
      outServer: 'omega-infer.exe',
      outQuant: 'llama-quantize.exe'
    }
  }
  return {
    server: 'llama-server',
    quant: 'llama-quantize',
    outServer: 'omega-infer',
    outQuant: 'llama-quantize'
  }
}

function walkFind(dir, fileName) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      const hit = walkFind(p, fileName)
      if (hit) return hit
    } else if (ent.name === fileName) {
      return p
    }
  }
  return null
}

function copyTreeDlls(srcDir, destDir) {
  if (!existsSync(srcDir)) return
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    const p = join(srcDir, ent.name)
    if (ent.isDirectory()) copyTreeDlls(p, destDir)
    else if (process.platform === 'win32' && ent.name.toLowerCase().endsWith('.dll')) {
      copyFileSync(p, join(destDir, ent.name))
    } else if (process.platform !== 'win32' && (ent.name.includes('.so') || ent.name.endsWith('.dylib'))) {
      copyFileSync(p, join(destDir, ent.name))
    }
  }
}

function findBuiltTool(buildDir, fileName) {
  const candidates = [
    join(buildDir, 'bin', 'Release', fileName),
    join(buildDir, 'bin', fileName),
    join(buildDir, 'Release', fileName),
    join(buildDir, fileName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return walkFind(buildDir, fileName)
}

function buildEnv(gpu) {
  const env = { ...process.env }
  if (gpu.enableCuda) env.OMEGA_GGML_CUDA = '1'
  else delete env.OMEGA_GGML_CUDA
  if (gpu.enableVulkan) {
    env.OMEGA_GGML_VULKAN = '1'
    applyVulkanSdkToEnv(env, gpu.vulkanSdk)
  } else {
    delete env.OMEGA_GGML_VULKAN
  }
  return env
}

function runCmakeBuild({ root, llamaRoot, buildDir, gpu, force = false, variantId }) {
  const cmake = resolveCmakePath()
  if (!cmake) {
    throw new Error(
      'cmake not found — install Visual Studio (Desktop C++) or CMake, or set OMEGA_CMAKE'
    )
  }

  const cmakeArgs = [
    '-S',
    llamaRoot,
    '-B',
    buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    ...llamaStandaloneCmakeArgs(gpu)
  ]

  const env = buildEnv(gpu)
  env.OMEGA_CMAKE = cmake

  console.log(`[build-infer-source] GPU: ${gpu.reason}`)
  console.log(`[build-infer-source] configure: ${cmake} ${cmakeArgs.join(' ')}`)

  if (process.platform === 'win32') {
    const ps1 = join(root, 'scripts', 'build-infer-source.ps1')
    const variant = variantId ?? process.env.OMEGA_LLAMA_VARIANT ?? ''
    if (!variant) {
      throw new Error('runCmakeBuild: variant id required on Windows (pass variantId or set OMEGA_LLAMA_VARIANT)')
    }
    const extra = ['-Variant', variant]
    if (force) extra.push('-Force')
    execPowerShellScript(ps1, extra, { cwd: root, stdio: 'inherit', env })
    return
  }

  execSync(`${cmake} ${cmakeArgs.map((a) => `"${a}"`).join(' ')}`, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env
  })
  execSync(`${cmake} --build "${buildDir}" --target llama-server llama-quantize -j ${env.OMEGA_BUILD_JOBS ?? 4}`, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env
  })
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./llama-variants.mjs').LlamaVariant} opts.variant
 * @param {boolean} [opts.force]
 * @param {string} [opts.tag]
 */
export function buildInferFromSource(opts) {
  const { root, variant, force = false, tag = null } = opts
  const n = namesForHost()
  const binDir = join(root, 'dist', 'bin', variant.inferSubdir)
  const inferPath = join(binDir, n.outServer)
  const quantPath = join(binDir, n.outQuant)
  const stampFile = join(binDir, '.fetch-stamp')

  mkdirSync(binDir, { recursive: true })
  if (existsSync(inferPath) && existsSync(quantPath) && !force) {
    console.log(`[build-infer-source] ${variant.id}: already present (use --force)`)
    return { skipped: true, binDir, sourceBuild: true }
  }

  const llamaRoot = join(root, 'apps', 'engine', 'native', 'third_party', 'llama.cpp')
  if (!existsSync(join(llamaRoot, 'CMakeLists.txt'))) {
    throw new Error(
      'llama.cpp source missing at apps/engine/native/third_party/llama.cpp — run: node scripts/sync-llama-cpp.mjs'
    )
  }

  patchLlamaCppCmakeGitDepends(llamaRoot)

  const gpu = resolveInferSourceGpuOptions(root, variant)
  if (variant.gpu === 'cuda' && !gpu.enableCuda) {
    throw new Error(
      `${variant.label} needs the NVIDIA CUDA toolkit (nvcc) for a source build — none detected`
    )
  }
  if (variant.gpu === 'vulkan' && !gpu.enableVulkan) {
    throw new Error(
      `${variant.label} needs the LunarG Vulkan SDK for a source build — install from https://vulkan.lunarg.com/`
    )
  }

  const buildDir = join(root, '.omega', 'build', 'llama-infer', variant.id)
  if (force && existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true })
  }
  mkdirSync(buildDir, { recursive: true })

  process.env.OMEGA_LLAMA_VARIANT = variant.id
  runCmakeBuild({ root, llamaRoot, buildDir, gpu, force, variantId: variant.id })

  const server = findBuiltTool(buildDir, n.server)
  const quant = findBuiltTool(buildDir, n.quant)
  if (!server || !quant) {
    throw new Error(
      `llama tools not found under ${buildDir} — expected ${n.server} and ${n.quant}`
    )
  }

  copyFileSync(server, inferPath)
  copyFileSync(quant, quantPath)
  copyTreeDlls(dirname(server), binDir)
  copyTreeDlls(join(buildDir, 'bin'), binDir)

  if (process.platform !== 'win32') {
    try {
      execSync(`chmod +x "${inferPath}" "${quantPath}"`, { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  }

  writeFileSync(
    stampFile,
    JSON.stringify(
      {
        tag: tag ?? 'source',
        variant: variant.id,
        sourceBuild: true,
        gpu: gpu.gpu,
        built: new Date().toISOString()
      },
      null,
      2
    )
  )
  console.log(`[build-infer-source] ${variant.id}: installed → ${binDir}`)
  return { skipped: false, binDir, sourceBuild: true }
}
