/**
 * Shared sync of a llama.cpp source tree into Omega paths.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { normalizeTag } from './llama-github.mjs'

const SKIP_DIR_NAMES = new Set([
  '.git',
  'build',
  '.cache',
  'node_modules',
  'out',
  'bin',
  'dist',
  '.vs',
  'CMakeFiles'
])

/** @param {string} srcRoot */
function copyFilter(srcRoot) {
  return (srcPath) => {
    const rel = relative(resolve(srcRoot), srcPath)
    if (!rel || rel === '.') return true
    const parts = rel.split(/[/\\]/)
    return !parts.some((p) => SKIP_DIR_NAMES.has(p))
  }
}

export function patchLlamaCppCmakeGitDepends(llamaRoot) {
  const cmakeCommon = join(llamaRoot, 'common', 'CMakeLists.txt')
  if (!existsSync(cmakeCommon)) return
  const marker = 'Omega: skip git index CMAKE_CONFIGURE_DEPENDS'
  let txt = readFileSync(cmakeCommon, 'utf8')
  if (txt.includes(marker)) return
  txt = txt.replace(
    /(\s*)set_property\(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "\$\{GIT_DIR\}\/index"\)/,
    `$1# ${marker}\n$1# set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "\${GIT_DIR}/index")`
  )
  writeFileSync(cmakeCommon, txt)
}

/**
 * @param {string} srcRoot absolute path to llama.cpp source
 * @param {string} omegaRoot Omega repo root
 * @param {string} tag release tag for metadata
 */
export function syncSourceIntoOmega(srcRoot, omegaRoot, tag) {
  const norm = tag === 'local' ? 'local' : normalizeTag(tag)
  const runtimeDest = join(omegaRoot, 'apps', 'engine', 'native', 'third_party', 'llama.cpp')

  function syncTree(dest) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(srcRoot, dest, { recursive: true, dereference: true, filter: copyFilter(srcRoot) })
  }

  console.log(`[sync] source: ${srcRoot} (tag=${norm})`)
  console.log(`[sync] → ${runtimeDest}`)
  syncTree(runtimeDest)
  patchLlamaCppCmakeGitDepends(runtimeDest)

  const hasMtp = existsSync(join(runtimeDest, 'common', 'speculative.cpp'))
  console.log(`[sync] done (tag=${norm}, MTP: ${hasMtp ? 'yes' : 'no'})`)
  return { tag: norm, hasMtp }
}
