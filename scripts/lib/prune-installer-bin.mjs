/**
 * Trim native installer payloads (NSIS mmap limit ~2GB on .7z).
 * - dist/bin: drop duplicate llama variant subdirs
 * - content-studio: omit .venv / __pycache__ (unified venv created at first run)
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const VARIANT_SUBDIRS = [
  'win-cuda',
  'win-vulkan',
  'nvidia-vulkan-windows',
  'linux-cuda',
  'linux-vulkan',
  'nvidia-vulkan-linux'
]

/** Directory names that must never ship in dist/native/Omega (NSIS path limits + wrong for end users). */
export const INSTALLER_SKIP_DIR_NAMES = new Set([
  '.venv',
  '__pycache__',
  '.git',
  'node_modules',
  '.next',
  'EBWebView'
])

/**
 * WebView2 user-data dirs created beside omega-desktop.exe during local runs (lockfiles break NSIS File /r).
 * @param {string} name
 */
export function isWebView2UserDataDirName(name) {
  return name.endsWith('.WebView2') || name === 'EBWebView'
}

/**
 * @param {string} absPath
 */
/** Claw3D ships a production Next build under .next/ — must not strip it like dev caches. */
export function isClaw3dOfficePackPath(absPath) {
  return absPath.replace(/\\/g, '/').includes('/claw3d-office/')
}

/** Next standalone trace — required at runtime; must not be pruned or skipped on copy. */
export function isClaw3dStandaloneTracePath(absPath) {
  return /\/claw3d-office\/\.next\/standalone\/(node_modules|\.next)(\/|$)/.test(
    absPath.replace(/\\/g, '/')
  )
}

export function shouldSkipInstallerPackPath(absPath) {
  const norm = absPath.replace(/\\/g, '/')
  const parts = norm.split('/')
  if (isClaw3dOfficePackPath(norm)) {
    if (isClaw3dStandaloneTracePath(norm)) return false
    if (parts.includes('node_modules')) return true
    return parts.some((seg) => seg === '.venv' || seg === '__pycache__' || seg === '.git')
  }
  return parts.some((seg) => INSTALLER_SKIP_DIR_NAMES.has(seg) || isWebView2UserDataDirName(seg))
}

/**
 * Recursive copy for installer staging — skips dev-only trees (.venv, __pycache__, …).
 * @param {string} src
 * @param {string} dest
 */
export function copyForInstallerPack(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => !shouldSkipInstallerPackPath(srcPath)
  })
}

/**
 * @param {string} root Omega repo root
 * @returns {{ removed: string[], beforeMb: number, afterMb: number }}
 */
export function pruneInstallerBin(root) {
  const binRoot = join(root, 'dist', 'bin')
  if (!existsSync(binRoot)) {
    return { removed: [], beforeMb: 0, afterMb: 0 }
  }

  const beforeMb = dirSizeMb(binRoot)
  const removed = []

  for (const id of VARIANT_SUBDIRS) {
    const sub = join(binRoot, id)
    if (existsSync(sub)) {
      rmSync(sub, { recursive: true, force: true })
      removed.push(id)
    }
  }

  const libDir = join(binRoot, 'lib')
  if (existsSync(libDir)) {
    rmSync(libDir, { recursive: true, force: true })
    removed.push('lib')
  }

  const afterMb = dirSizeMb(binRoot)
  return { removed, beforeMb, afterMb }
}

/**
 * @param {string} root Omega repo root
 * @returns {{ removed: boolean, freedMb: number }}
 */
export function pruneContentStudioVenv(root) {
  const candidates = [
    join(root, 'apps', 'desktop', 'content-studio', 'backend', '.venv'),
    join(root, 'dist', 'native', 'Omega', 'resources', 'content-studio', 'backend', '.venv')
  ]
  let removed = false
  let freedMb = 0
  for (const venv of candidates) {
    if (!existsSync(venv)) continue
    const mb = dirSizeMb(venv)
    console.log(`[pack] content-studio: removing .venv before installer pack (~${mb} MB)…`)
    rmSync(venv, { recursive: true, force: true })
    removed = true
    freedMb += mb
  }
  return { removed, freedMb }
}

/**
 * Stop shell so WebView2 lockfiles beside dist/shell or dist/native/Omega can be removed.
 */
export function stopOmegaShellForPack() {
  if (process.platform !== 'win32') return
  for (const args of [
    ['/IM', 'omega-desktop.exe', '/T'],
    ['/IM', 'omega-desktop.exe', '/F', '/T']
  ]) {
    spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
  }
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500'], {
    stdio: 'ignore',
    windowsHide: true
  })
}

/**
 * @param {string} dir
 */
function rmDirForce(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
      return true
    } catch (err) {
      if (attempt === 2) throw err
      stopOmegaShellForPack()
    }
  }
  return false
}

/**
 * Drop WebView2 cache beside shell exe (created when running from dist/shell or dist/native/Omega).
 * @param {string} root Omega repo root
 */
export function pruneWebView2UserData(root) {
  stopOmegaShellForPack()
  const removed = []
  for (const base of [
    join(root, 'dist', 'shell'),
    join(root, 'dist', 'native', 'Omega')
  ]) {
    if (!existsSync(base)) continue
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory() || !isWebView2UserDataDirName(ent.name)) continue
      const p = join(base, ent.name)
      rmDirForce(p)
      removed.push(p.replace(/\\/g, '/'))
    }
  }
  if (removed.length) {
    console.log(`[pack] removed WebView2 user-data dir(s): ${removed.join(', ')}`)
  }
  return { removed }
}

/**
 * Remove dev-only trees from staged dist/native/Omega before NSIS (path length + size).
 * @param {string} root Omega repo root
 */
export function pruneNativeInstallerPayload(root) {
  pruneWebView2UserData(root)
  const staged = join(root, 'dist', 'native', 'Omega')
  const removed = []
  if (existsSync(staged)) {
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const p = join(dir, ent.name)
        if (isWebView2UserDataDirName(ent.name)) {
          rmDirForce(p)
          removed.push(p.replace(/\\/g, '/'))
          continue
        }
        if (INSTALLER_SKIP_DIR_NAMES.has(ent.name)) {
          const rel = p.replace(/\\/g, '/')
          if (ent.name === '.next' && rel.includes('/claw3d-office/')) {
            walk(p)
            continue
          }
          if (ent.name === 'node_modules' && isClaw3dStandaloneTracePath(rel)) {
            walk(p)
            continue
          }
          rmDirForce(p)
          removed.push(rel)
          continue
        }
        walk(p)
      }
    }
    walk(staged)
  }
  const venv = pruneContentStudioVenv(root)
  if (removed.length) {
    console.log(`[pack] pruned ${removed.length} dev tree(s) from dist/native/Omega`)
  }
  return { removed, venvRemoved: venv.removed, venvFreedMb: venv.freedMb }
}

/**
 * @param {string} dir
 */
function dirSizeMb(dir) {
  let total = 0
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else total += st.size
    }
  }
  walk(dir)
  return Math.round(total / 1024 / 1024)
}
