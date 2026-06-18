#!/usr/bin/env node
/**
 * Patch node-llama-cpp GGUF parser so native model load works on Qwen-class GGUFs.
 *
 * Root cause: readGgufFileInfo() materializes huge tokenizer.* arrays and chokes on
 * merges blobs that stop matching per-string length prefixes before the declared count.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const templateDir = join(root, 'scripts', 'patches', 'node-llama-cpp-gguf')
const PATCHED_FILES = [
  ['dist/gguf/parser/GgufV2Parser.js', 'GgufV2Parser.js'],
  ['dist/gguf/fileReaders/GgufFileReader.js', 'GgufFileReader.js'],
  ['dist/gguf/fileReaders/GgufFsFileReader.js', 'GgufFsFileReader.js']
]

/** @param {string} path */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * @param {string} [repoRoot]
 * @returns {boolean} true if any file changed
 */
export function applyNodeLlamaCppGgufNativeFix(repoRoot = root) {
  const pkgRoot = join(repoRoot, 'node_modules', 'node-llama-cpp')
  if (!existsSync(join(pkgRoot, 'package.json'))) {
    console.warn('[patch] node-llama-cpp not found — skip')
    return false
  }
  let changed = false
  for (const [rel, templateName] of PATCHED_FILES) {
    const dest = join(pkgRoot, rel)
    const src = join(templateDir, templateName)
    if (!existsSync(src)) {
      console.warn(`[patch] missing template ${templateName}`)
      continue
    }
    if (!existsSync(dest) || sha256(dest) !== sha256(src)) {
      copyFileSync(src, dest)
      changed = true
    }
  }
  if (changed) {
    console.log('[patch] applied node-llama-cpp GGUF native load fix')
  }
  return changed
}

if (process.argv[1] && process.argv[1].endsWith('patch-node-llama-cpp-gguf.mjs')) {
  applyNodeLlamaCppGgufNativeFix()
}
