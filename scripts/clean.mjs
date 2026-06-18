#!/usr/bin/env node
/**
 * Remove compile/installer outputs (keeps node_modules, dist/bin, repo .omega / llama caches).
 * Full reset: npm run clean:fresh  or  clean.bat
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLAW3D_DEV_DIRS,
  CMAKE_BUILD_DIRS,
  DESKTOP_BUILD_DIRS,
  ROOT_LOG_FILES,
  removeDistChildren
} from './lib/clean-artifacts.mjs'
import { removePath } from './lib/clean-workspace.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const opts = { log: (msg) => console.log(`[clean] ${msg}`) }

removeDistChildren(root, opts)

for (const rel of CMAKE_BUILD_DIRS) {
  removePath(root, rel, opts)
}

for (const rel of DESKTOP_BUILD_DIRS) {
  removePath(root, rel, opts)
}

for (const rel of CLAW3D_DEV_DIRS) {
  removePath(root, rel, opts)
}

for (const rel of ROOT_LOG_FILES) {
  removePath(root, rel, opts)
}

console.log('[clean] done — run: npm install && npm run build')
