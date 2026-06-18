/**
 * Resolve omega-engine CMake build directory.
 * Vulkan (ggml-vulkan) uses ExternalProject paths that exceed MAX_PATH under long repo roots.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const NESTED_VULKAN_SUFFIX =
  '\\omega_infer_build\\llama_cpp_build\\ggml\\src\\ggml-vulkan\\vulkan-shaders-gen-prefix\\src\\vulkan-shaders-gen-build\\CMakeFiles\\CMakeScratch\\TryCompile-stub\\cmTC_stub.dir\\Debug\\cmTC_stub.tlog\\link.write.1.tlog'

/** @param {string} p */
function normalizePath(p) {
  return resolve(p).replace(/\//g, '\\').toLowerCase()
}

/** Stable short id so each clone gets its own short build dir under %LOCALAPPDATA%\\O\\. */
export function engineBuildDirRepoId(root) {
  return createHash('sha256').update(normalizePath(root)).digest('hex').slice(0, 8)
}

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
  const longRepo =
    /\\Desktop\\|\\OneDrive\\|\\Downloads\\/i.test(root) || root.length > 48
  const needsShort =
    process.platform === 'win32' &&
    (gpu.enableVulkan || longRepo || defaultLongest >= maxPath)

  if (!needsShort) {
    return { dir: defaultDir, short: false, reason: 'in-tree apps/engine/build' }
  }

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const repoId = engineBuildDirRepoId(root)
  const shortDir = join(localAppData, 'O', `eb-${repoId}`)
  mkdirSync(shortDir, { recursive: true })
  const reason = gpu.enableVulkan
    ? 'Vulkan shader build needs a short path (Windows MAX_PATH)'
    : 'repo path is long for MSVC nested build dirs'
  return { dir: shortDir, short: true, reason, repoId }
}

/** @param {string} buildDir */
export function engineBuildDirStampPath(buildDir) {
  return join(buildDir, '.omega-build-dir')
}

/**
 * @param {string} buildDir
 * @returns {string | null}
 */
export function cmakeCacheSourceRoot(buildDir) {
  const cachePath = join(buildDir, 'CMakeCache.txt')
  if (!existsSync(cachePath)) return null
  const text = readFileSync(cachePath, 'utf8')
  const m = text.match(/(?:^|\n)CMAKE_HOME_DIRECTORY:INTERNAL=([^\n]+)/m)
  return m ? normalizePath(m[1]) : null
}

/**
 * Drop stale CMake cache when the repo was moved or cloned to a new folder.
 * @param {string} root repo root
 * @param {string} buildDir
 * @returns {boolean} true if cache was cleared
 */
export function invalidateEngineBuildCacheIfSourceMoved(root, buildDir) {
  const cached = cmakeCacheSourceRoot(buildDir)
  if (!cached) return false
  const current = normalizePath(join(root, 'apps', 'engine'))
  if (cached === current) return false
  console.log(
    `[build-engine] CMake cache is from a different folder (${cached}) — clearing for ${current}`
  )
  rmSync(join(buildDir, 'CMakeCache.txt'), { force: true })
  rmSync(engineBuildDirStampPath(buildDir), { force: true })
  rmSync(join(buildDir, '.omega-gpu-backend'), { force: true })
  return true
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
