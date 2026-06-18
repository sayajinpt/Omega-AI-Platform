/**
 * Resolve omega-engine CMake build directory.
 * Vulkan (ggml-vulkan) uses ExternalProject paths that exceed MAX_PATH under long repo roots.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NESTED_VULKAN_SUFFIX =
  '\\omega_infer_build\\llama_cpp_build\\ggml\\src\\ggml-vulkan\\vulkan-shaders-gen-prefix\\src\\vulkan-shaders-gen-build\\CMakeFiles\\CMakeScratch\\TryCompile-stub\\cmTC_stub.dir\\Debug\\cmTC_stub.tlog\\link.write.1.tlog'

/** @param {string} buildRoot */
function estimateLongestBuildPath(buildRoot) {
  return (buildRoot + NESTED_VULKAN_SUFFIX).length
}

/**
 * @param {string} root repo root
 * @param {{ enableVulkan?: boolean }} [gpu]
 * @returns {{ dir: string, short: boolean, reason: string }}
 */
export function resolveEngineBuildDir(root, gpu = {}) {
  const override = process.env.OMEGA_ENGINE_BUILD_DIR?.trim()
  if (override) {
    mkdirSync(override, { recursive: true })
    return { dir: override, short: false, reason: 'OMEGA_ENGINE_BUILD_DIR' }
  }

  const defaultDir = join(root, 'apps', 'engine', 'build')
  const maxPath = 250
  const defaultLongest = estimateLongestBuildPath(defaultDir)
  const longRepo = /\\Desktop\\|\\OneDrive\\/i.test(root) || root.length > 48
  const needsShort =
    process.platform === 'win32' &&
    (gpu.enableVulkan || longRepo || defaultLongest >= maxPath)

  if (!needsShort) {
    return { dir: defaultDir, short: false, reason: 'in-tree apps/engine/build' }
  }

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const shortDir = join(localAppData, 'O', 'eb')
  mkdirSync(shortDir, { recursive: true })
  const reason = gpu.enableVulkan
    ? 'Vulkan shader build needs a short path (Windows MAX_PATH)'
    : 'repo path is long for MSVC nested build dirs'
  return { dir: shortDir, short: true, reason }
}

/** @param {string} buildDir */
export function engineBuildDirStampPath(buildDir) {
  return join(buildDir, '.omega-build-dir')
}

/**
 * @param {string} root
 * @param {string} buildDir
 * @param {{ short: boolean, reason: string }} meta
 */
export function noteEngineBuildDir(root, buildDir, meta) {
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(
    engineBuildDirStampPath(buildDir),
    `${JSON.stringify({ root, buildDir, ...meta, notedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  )
}
