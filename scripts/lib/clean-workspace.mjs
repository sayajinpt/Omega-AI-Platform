/**
 * Shared removal of npm install trees across the Omega monorepo.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'

const EXTRA_NODE_MODULE_PATHS = [
  'apps/desktop/claw3d-office/node_modules',
  'apps/desktop/.llama-pack-staging'
]

const IS_WIN = platform() === 'win32'

/**
 * @param {string} root Omega repo root
 */
export function listWorkspaceDirs(root) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return []
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : []
  const dirs = new Set()
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const slash = pattern.indexOf('/')
      const base = slash === -1 ? pattern.replace(/\*+$/, '') : pattern.slice(0, slash + 1)
      const basePath = join(root, base)
      if (!existsSync(basePath)) continue
      const star = pattern.slice(slash + 1)
      if (star === '*') {
        for (const ent of readdirSync(basePath, { withFileTypes: true })) {
          if (ent.isDirectory()) dirs.add(join(base, ent.name))
        }
      }
    } else {
      dirs.add(pattern.replace(/\\/g, '/'))
    }
  }
  return [...dirs]
}

/**
 * @param {string} target Absolute path to delete
 */
function rmTreeSync(target) {
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250
  })
}

/**
 * Windows often keeps handles open on node_modules (IDE, Omega, node, CUDA build).
 * Rename first so new installs can proceed, then delete the renamed tree.
 * @param {string} target
 */
function rmTreeSyncWindows(target) {
  try {
    rmTreeSync(target)
    return
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
      throw err
    }
  }

  const trash = `${target}.__omega_delete_${process.pid}_${Date.now()}`
  renameSync(target, trash)
  try {
    rmTreeSync(trash)
  } catch (err) {
  // Renamed away — install can continue; leave trash for manual cleanup.
    const hint =
      'Close Omega and Cursor, stop Node/llama build processes, then delete: ' + trash
    const wrap = new Error(hint, { cause: err })
    wrap.code = 'OMEGA_CLEAN_PARTIAL'
    throw wrap
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [opts]
 * @returns {boolean} true if path existed
 */
export function removePath(root, rel, opts = {}) {
  const p = join(root, rel)
  if (!existsSync(p)) return false
  const log = opts.log ?? ((msg) => console.log(msg))
  if (opts.dryRun) {
    log(`would remove ${rel}`)
    return true
  }
  try {
    if (IS_WIN) {
      rmTreeSyncWindows(p)
    } else {
      rmTreeSync(p)
    }
    log(`removed ${rel}`)
    return true
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'OMEGA_CLEAN_PARTIAL') {
      log(`renamed (delete manually): ${rel}`)
      return true
    }
    const msg = /** @type {Error} */ (err).message
    throw new Error(
      `Failed to remove ${rel}: ${msg}\n` +
        'Close Omega, close Cursor/VS Code terminals using this repo, end node.exe tasks ' +
        '(Task Manager), then rerun the build.',
      { cause: err }
    )
  }
}

/**
 * @param {string} root
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [opts]
 */
export function removeAllNodeModules(root, opts = {}) {
  const log = opts.log ?? ((msg) => console.log(msg))
  log('clearing npm trees…')

  const relPaths = []
  for (const ws of listWorkspaceDirs(root)) {
    relPaths.push(join(ws, 'node_modules').replace(/\\/g, '/'))
  }
  for (const rel of EXTRA_NODE_MODULE_PATHS) {
    relPaths.push(rel)
  }
  // Root last — most likely to be locked by tooling.
  relPaths.push('node_modules')

  for (const rel of relPaths) {
    removePath(root, rel, { ...opts, log })
  }
}
