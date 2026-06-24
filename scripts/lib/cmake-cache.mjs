/**
 * Portable CMake cache helpers — safe when repo is cloned/moved (any path, any user).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @param {string} p */
export function normalizePath(p) {
  return resolve(p).replace(/\//g, '\\').toLowerCase()
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
 * @param {string} sourceDir CMake -S directory (e.g. apps/engine)
 * @param {string} buildDir CMake -B directory
 * @param {string} label log prefix
 * @param {string[]} [extraStampFiles]
 * @returns {boolean}
 */
export function invalidateCmakeCacheIfSourceMoved(sourceDir, buildDir, label, extraStampFiles = []) {
  const cached = cmakeCacheSourceRoot(buildDir)
  if (!cached) return false
  const current = normalizePath(sourceDir)
  if (cached === current) return false
  console.log(`[${label}] CMake cache is from a different folder — clearing (was: ${cached})`)
  rmSync(join(buildDir, 'CMakeCache.txt'), { force: true })
  for (const rel of extraStampFiles) {
    rmSync(join(buildDir, rel), { force: true })
  }
  return true
}

/** NMake / stale caches break Windows Visual Studio `-A x64` configures. */
export function clearIncompatibleWindowsCmakeCache(buildDir) {
  if (process.platform !== 'win32') return false
  const cachePath = join(buildDir, 'CMakeCache.txt')
  if (!existsSync(cachePath)) return false
  const text = readFileSync(cachePath, 'utf8')
  const needsClear =
    /CMAKE_GENERATOR:INTERNAL=NMake Makefiles/m.test(text) ||
    /CMAKE_GENERATOR:INTERNAL=MinGW Makefiles/m.test(text) ||
    (/CMAKE_GENERATOR:INTERNAL=Visual Studio/m.test(text) &&
      /CMAKE_GENERATOR_PLATFORM:INTERNAL=\s*$/m.test(text))
  if (!needsClear) return false
  console.log(`[cmake] clearing incompatible Windows CMake cache in ${buildDir}`)
  rmSync(cachePath, { force: true })
  rmSync(join(buildDir, 'CMakeFiles'), { recursive: true, force: true })
  return true
}

/** Drop pre-v2 shared engine cache dir (%LOCALAPPDATA%\\O\\eb) so clones never collide. */
export function pruneLegacySharedEngineBuildCache() {
  if (process.platform !== 'win32') return false
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const legacy = join(localAppData, 'O', 'eb')
  const cache = join(legacy, 'CMakeCache.txt')
  if (!existsSync(cache)) return false
  console.log(`[build-engine] removing legacy shared CMake cache: ${legacy}`)
  rmSync(cache, { force: true })
  rmSync(join(legacy, '.omega-gpu-backend'), { force: true })
  rmSync(join(legacy, '.omega-build-dir'), { force: true })
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--clear-nmake')) {
    const dir = process.argv[process.argv.length - 1]
    if (dir && !dir.startsWith('-') && dir !== process.argv[1]) {
      clearIncompatibleWindowsCmakeCache(dir)
    }
  }
}
