/**
 * Copy files for installer packaging — skip .git and llama.cpp build artifacts.
 */
const fs = require('fs')
const path = require('path')

const LLAMA_CPP_SKIP = new Set(['build', '.cache', 'CMakeFiles', '.vs', 'out', 'bin', 'dist'])

/**
 * @param {string} srcRoot
 * @returns {(srcPath: string) => boolean}
 */
function packCopyFilter(srcRoot) {
  const root = path.resolve(srcRoot)
  return (srcPath) => {
    const resolved = path.resolve(srcPath)
    const rel = path.relative(root, resolved)
    if (!rel || rel === '.') return true
    const parts = rel.split(/[/\\]/)
    if (parts.includes('.git')) return false
    const llamaIdx = parts.indexOf('llama.cpp')
    if (llamaIdx >= 0) {
      const tail = parts.slice(llamaIdx + 1)
      if (tail.some((p) => LLAMA_CPP_SKIP.has(p))) return false
    }
    return true
  }
}

/**
 * @param {string} src
 * @param {string} dest
 */
function packCpSync(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    force: true,
    filter: packCopyFilter(src)
  })
}

module.exports = { packCpSync, packCopyFilter }
