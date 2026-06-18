/**
 * Canonical list of generated paths under the Omega repo (not user ~/.omega).
 * Used by scripts/clean.mjs and scripts/clean-fresh.mjs.
 */
import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { removePath } from './clean-workspace.mjs'
import { pruneWebView2UserData, stopOmegaShellForPack } from './prune-installer-bin.mjs'

/** Partial clean (npm run clean): drop compile outputs but keep dist/bin prebuilts. */
export const DIST_PARTIAL_CHILDREN = [
  'runtime',
  'engine',
  'ui',
  'shell',
  'native',
  'content-studio',
  'claw3d-office',
  'desktop',
  'llama-build.json'
]

/** CMake and native compile trees (recreated by build:runtime / build:shell / build-engine). */
export const CMAKE_BUILD_DIRS = [
  'apps/runtime/build',
  'apps/shell/build',
  'apps/engine/build',
  'apps/engine/native/build',
  'apps/shell/third_party/webview2'
]

/** Electron-era / desktop packaging leftovers. */
export const DESKTOP_BUILD_DIRS = ['apps/desktop/out', 'apps/desktop/dist', 'packages/sdk/dist']

/** Logs at repo root. */
export const ROOT_LOG_FILES = ['build-log.txt', 'npm-install-debug.txt']

/** Claw3D dev trees (production .next is rebuilt by ensure-claw3d-office). */
export const CLAW3D_DEV_DIRS = [
  'apps/desktop/claw3d-office/.next',
  'apps/desktop/claw3d-office/node_modules',
  'apps/desktop/.llama-pack-staging'
]

/**
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export function removeDistOutputs(root, opts = {}) {
  return removePath(root, 'dist', opts)
}

/**
 * Partial clean: dist children only (keeps dist/ itself if other files exist).
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export function removeDistChildren(root, opts = {}) {
  for (const child of DIST_PARTIAL_CHILDREN) {
    removePath(root, join('dist', child).replace(/\\/g, '/'), opts)
  }
}

/**
 * Repo-local .omega (llama lock + source caches). Does not touch %USERPROFILE%/.omega.
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void, keepLlamaSetup?: boolean }} opts
 */
export function removeRepoOmegaDir(root, opts = {}) {
  const log = opts.log ?? (() => {})
  if (opts.keepLlamaSetup) {
    removePath(root, '.omega/cache', opts)
    return
  }
  removePath(root, '.omega', opts)
}

/**
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export function removeLlamaSyncedTree(root, opts = {}) {
  removePath(root, 'apps/engine/native/third_party/llama.cpp', opts)
}

/**
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export function removePrebuiltFlashWheels(root, opts = {}) {
  const log = opts.log ?? (() => {})
  const dir = join(root, 'apps/desktop/content-studio/prebuilt-wheels')
  if (!existsSync(dir)) return
  let n = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.whl')) continue
    const rel = `apps/desktop/content-studio/prebuilt-wheels/${name}`
    if (opts.dryRun) {
      log(`would remove ${rel}`)
    } else {
      unlinkSync(join(root, rel))
      log(`removed ${rel}`)
    }
    n++
  }
  if (n && !opts.dryRun) log(`removed ${n} prebuilt wheel(s)`)
}

/**
 * Dev-only Python trees under content-studio (not shipped; unified venv is under ~/.omega).
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export function removeContentStudioDevArtifacts(root, opts = {}) {
  removePath(root, 'apps/desktop/content-studio/backend/.venv', opts)
  removePrebuiltFlashWheels(root, opts)
  removePath(root, 'apps/desktop/content-studio/backend/data', opts)

  const csRoot = join(root, 'apps/desktop/content-studio')
  if (!existsSync(csRoot)) return

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === '__pycache__' || ent.name.endsWith('.egg-info')) {
          const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
          removePath(root, rel, opts)
          continue
        }
        if (ent.name === '.venv' || ent.name === 'node_modules') continue
        walk(abs)
      }
    }
  }
  walk(csRoot)
}

/**
 * Leftover node_modules rename targets from Windows clean (see clean-workspace.mjs).
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export function removeStaleNodeModuleTrash(root, opts = {}) {
  const log = opts.log ?? (() => {})
  const scan = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (ent.name.includes('__omega_delete_')) {
        const rel = join(dir, ent.name).slice(root.length + 1).replace(/\\/g, '/')
        removePath(root, rel, opts)
        continue
      }
      if (ent.name === 'node_modules' || ent.name === 'apps' || ent.name === 'packages') {
        scan(join(dir, ent.name))
      }
    }
  }
  scan(root)
}

/**
 * Stop running shell and drop WebView2 profile dirs under dist (Windows file locks).
 * @param {string} root
 */
export function prepareWindowsClean(root) {
  if (process.platform !== 'win32') return
  stopOmegaShellForPack()
  pruneWebView2UserData(root)
}
