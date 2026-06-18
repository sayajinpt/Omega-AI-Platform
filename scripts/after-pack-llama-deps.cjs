/**
 * Legacy electron-builder afterPack hook — unused by native build (npm run build:win-native).
 * Copy staged node-llama-cpp tree into resources/llama-js only.
 */
const fs = require('fs')
const path = require('path')
const { packCpSync } = require('./lib/fs-copy-pack.cjs')

/** node-llama-cpp ESM imports `chalk` — must exist beside the unpacked package. */
function ensureChalkBesideLlama(unpackedRoot, repoRoot) {
  const dest = path.join(unpackedRoot, 'node-llama-cpp', 'node_modules', 'chalk')
  if (fs.existsSync(path.join(dest, 'package.json'))) return

  const sources = [
    path.join(repoRoot, 'node_modules', 'node-llama-cpp', 'node_modules', 'chalk'),
    path.join(repoRoot, 'node_modules', 'chalk'),
    path.join(unpackedRoot, 'chalk')
  ]
  const src = sources.find((p) => fs.existsSync(path.join(p, 'package.json')))
  if (!src) {
    console.warn('after-pack-llama-deps: chalk package not found for nested copy')
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: true })
  console.log('after-pack-llama-deps: copied chalk → node-llama-cpp/node_modules/chalk')
}

/**
 * @param {string} appOutDir
 * @param {string} repoRoot
 */
async function ensureLlamaDepsUnpacked(appOutDir, repoRoot) {
  const { STAGING_DIR, stageLlamaPackBundle, verifyStagedLlamaImports } = await import(
    './node-llama-pack-deps.mjs'
  )

  if (!fs.existsSync(STAGING_DIR)) {
    console.log('after-pack-llama-deps: staging missing, rebuilding…')
    stageLlamaPackBundle(repoRoot)
  }

  const dir = path.join(appOutDir, 'resources', 'llama-js', 'node_modules')
  fs.mkdirSync(dir, { recursive: true })
  packCpSync(STAGING_DIR, dir)
  ensureChalkBesideLlama(dir, repoRoot)
  const verify = verifyStagedLlamaImports(repoRoot, dir)
  if (!verify.ok) {
    throw new Error(
      `after-pack-llama-deps: llama-js import check failed (${verify.missing.length} missing). Re-run npm run build:win`
    )
  }
  const entry = path.join(dir, 'node-llama-cpp', 'dist', 'index.js')
  if (!fs.existsSync(entry)) {
    throw new Error(`after-pack-llama-deps: missing ${entry}`)
  }
  console.log(`after-pack-llama-deps: llama-js ok (${entry})`)
}

module.exports = { ensureLlamaDepsUnpacked }
