#!/usr/bin/env node
/**
 * Remove npm install trees so the next `npm install` is a full workspace install.
 * Used by build-windows.ps1 before step 1.
 * For a full clean (binaries, llama caches, dist), use: npm run clean:fresh
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeAllNodeModules } from './lib/clean-workspace.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

try {
  removeAllNodeModules(root, {
    log: (msg) => console.log(`[clean-install] ${msg}`)
  })
  console.log('[clean-install] done — run: npm install')
} catch (err) {
  console.error(`[clean-install] ${/** @type {Error} */ (err).message}`)
  process.exit(1)
}
