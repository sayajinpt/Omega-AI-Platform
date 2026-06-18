#!/usr/bin/env node
/**
 * Sync llama.cpp source into Omega (runtime native tree).
 *
 * Source resolution (first match):
 *  1. LLAMA_CPP_SOURCE env
 *  2. .omega/llama-setup.json → cached source or sourcePath
 *  3. .omega/cache/llama.cpp-src/<tag>  (tag from --tag= or lock)
 *  4. ../llama.cpp-b9247 / ../llama.cpp (legacy local folders)
 *
 * Fetch from GitHub:
 *   node scripts/sync-llama-cpp.mjs --fetch [--tag=b9253]
 *   OMEGA_LLAMA_FETCH_SOURCE=1 npm run sync:llama-cpp
 */
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ensureSourceTree,
  fetchRelease,
  normalizeTag,
  readSetupLock,
  sourceCacheDir,
  writeSetupLock
} from './lib/llama-github.mjs'
import { syncSourceIntoOmega } from './lib/llama-sync-core.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(scriptsDir, '..')

const fetchFlag =
  process.argv.includes('--fetch') || process.env.OMEGA_LLAMA_FETCH_SOURCE === '1'
const tagArg = process.argv.find((a) => a.startsWith('--tag='))?.split('=')[1]

/** @returns {string | null} */
export function resolveLlamaCppSource(root = REPO_ROOT) {
  const fromEnv = process.env.LLAMA_CPP_SOURCE?.trim()
  if (fromEnv && existsSync(join(fromEnv, 'CMakeLists.txt'))) {
    return resolve(fromEnv)
  }

  const lock = readSetupLock(root)
  if (lock?.sourcePath && existsSync(join(lock.sourcePath, 'CMakeLists.txt'))) {
    return resolve(lock.sourcePath)
  }
  if (lock?.tag) {
    const cached = sourceCacheDir(root, lock.tag)
    if (existsSync(join(cached, 'CMakeLists.txt'))) return cached
  }

  const tag =
    tagArg?.trim() ||
    process.env.LLAMA_CPP_TAG?.trim() ||
    lock?.tag
  if (tag) {
    const cached = sourceCacheDir(root, tag)
    if (existsSync(join(cached, 'CMakeLists.txt'))) return cached
  }

  const candidates = [
    join(root, '..', 'llama.cpp-b9247'),
    join(root, '..', 'llama.cpp'),
    join(root, 'llama.cpp-b9247'),
    join(root, 'llama.cpp')
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'CMakeLists.txt'))) return resolve(c)
  }
  return null
}

/**
 * @param {string} [root]
 * @returns {Promise<boolean>}
 */
export async function syncLlamaCpp(root = REPO_ROOT) {
  let src = resolveLlamaCppSource(root)
  let tag =
    tagArg?.trim() ||
    process.env.LLAMA_CPP_TAG?.trim() ||
    readSetupLock(root)?.tag ||
    'local'

  if (!src && fetchFlag) {
    const release = await fetchRelease(tag === 'local' ? 'latest' : tag, { root })
    tag = normalizeTag(tag === 'local' ? release.tag_name : tag)
    console.log(`[sync-llama-cpp] Downloading source ${tag} from GitHub…`)
    src = await ensureSourceTree(root, tag)
    const lock = readSetupLock(root) ?? {}
    writeSetupLock(root, {
      ...lock,
      repo: 'ggml-org/llama.cpp',
      tag,
      sourcePath: src,
      fetchedAt: new Date().toISOString()
    })
  }

  if (!src) {
    console.log(
      '[sync-llama-cpp] No local llama.cpp tree found.\n' +
        '  Run: npm run setup:llama\n' +
        '  Or:  npm run sync:llama-cpp -- --fetch\n' +
        '  Or:  set LLAMA_CPP_SOURCE to a checkout with CMakeLists.txt'
    )
    return false
  }

  if (tag === 'local') {
    tag =
      process.env.LLAMA_CPP_TAG?.trim() ||
      src.split(/[/\\]/).pop()?.replace(/^llama\.cpp-?/, '') ||
      'local'
  }
  if (tag !== 'local') tag = normalizeTag(tag)

  syncSourceIntoOmega(src, root, tag)

  console.log('[sync-llama-cpp] rebuild native: npm run build:native && npm run build:runtime:native')
  console.log('[sync-llama-cpp] rebuild engine: node scripts/build-engine.mjs')
  return true
}

/** @param {string} [root] @returns {boolean} */
export function syncLlamaCppSync(root = REPO_ROOT) {
  const src = resolveLlamaCppSource(root)
  if (!src) return false
  let tag =
    tagArg?.trim() ||
    process.env.LLAMA_CPP_TAG?.trim() ||
    readSetupLock(root)?.tag ||
    src.split(/[/\\]/).pop()?.replace(/^llama\.cpp-?/, '') ||
    'local'
  tag = tag.startsWith('b') ? tag : tag === 'local' ? 'local' : `b${tag}`
  syncSourceIntoOmega(src, root, tag)
  return true
}

if (process.argv[1]?.endsWith('sync-llama-cpp.mjs')) {
  if (fetchFlag) {
    syncLlamaCpp().catch((e) => {
      console.error(e)
      process.exit(1)
    })
  } else {
    const ok = syncLlamaCppSync()
    if (!ok) process.exit(1)
  }
}
