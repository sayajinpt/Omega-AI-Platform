/**
 * NVIDIA CUDA runtime DLLs are shipped once under dist/bin/ and loaded via PATH
 * by omega-engine, omega-infer, and bundled Ollama (when CUDA backends are used).
 */
import { copyFileSync, existsSync, linkSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{ removed: string[], freedMb: number }} StripResult */
/** @typedef {{ linked: string[], errors: { name: string, message: string }[] }} LinkResult */

/** Windows NVIDIA runtime redistributables (not ggml-cuda / omega_infer). */
export const CUDA_RUNTIME_DLL_RE =
  /^(cudart64_\d+\.dll|cublas64_\d+\.dll|cublasLt64_\d+\.dll)$/i

/** @param {string} name */
export function isCudaRuntimeDll(name) {
  return CUDA_RUNTIME_DLL_RE.test(name)
}

/**
 * Hard-link shared CUDA runtime DLLs into engine/ so Windows can resolve them next to
 * omega-engine.exe without duplicating file bytes (NTFS hard link → same inode as bin/).
 * @param {string} engineDir
 * @param {string} binDir
 * @returns {LinkResult}
 */
export function ensureCudaRuntimeHardlinks(engineDir, binDir) {
  if (!existsSync(engineDir) || !existsSync(binDir)) {
    return { linked: [], errors: [] }
  }

  const linked = []
  const errors = []
  for (const name of readdirSync(binDir)) {
    if (!isCudaRuntimeDll(name)) continue
    const src = join(binDir, name)
    if (!statSync(src).isFile()) continue
    const dest = join(engineDir, name)
    try {
      if (existsSync(dest)) {
        unlinkSync(dest)
      }
      linkSync(src, dest)
      linked.push(name)
    } catch (e) {
      errors.push({
        name,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return { linked, errors }
}

/**
 * Copy CUDA runtime DLLs into engine/ when hard links are unavailable (cross-volume installs).
 * @param {string} engineDir
 * @param {string} binDir
 * @returns {{ copied: string[], errors: { name: string, message: string }[] }}
 */
export function copyCudaRuntimeToEngine(engineDir, binDir) {
  if (!existsSync(engineDir) || !existsSync(binDir)) {
    return { copied: [], errors: [] }
  }

  const copied = []
  const errors = []
  for (const name of readdirSync(binDir)) {
    if (!isCudaRuntimeDll(name)) continue
    const src = join(binDir, name)
    if (!statSync(src).isFile()) continue
    const dest = join(engineDir, name)
    try {
      copyFileSync(src, dest)
      copied.push(name)
    } catch (e) {
      errors.push({
        name,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return { copied, errors }
}

/**
 * Prefer NTFS hard links; fall back to full copies for packaged installs.
 * @param {string} engineDir
 * @param {string} binDir
 */
export function ensureCudaRuntimeInEngine(engineDir, binDir) {
  if (!existsSync(engineDir) || !existsSync(binDir)) {
    return {
      mode: 'none',
      hard: { linked: [], errors: [] },
      copy: { copied: [], errors: [] }
    }
  }
  const hard = ensureCudaRuntimeHardlinks(engineDir, binDir)
  const needCopy = []
  for (const name of readdirSync(binDir)) {
    if (!isCudaRuntimeDll(name)) continue
    const dest = join(engineDir, name)
    if (!existsSync(dest)) needCopy.push(name)
  }
  if (needCopy.length === 0) {
    return { mode: hard.linked.length ? 'hardlink' : 'none', hard, copy: { copied: [], errors: [] } }
  }
  const copy = copyCudaRuntimeToEngine(engineDir, binDir)
  return { mode: copy.copied.length ? 'copy' : hard.linked.length ? 'hardlink' : 'none', hard, copy }
}

/**
 * @param {string} appOutDir electron-builder win-unpacked directory
 * @returns {LinkResult}
 */
export function ensureCudaRuntimeHardlinksInPackagedApp(appOutDir) {
  const resources = join(appOutDir, 'resources')
  return ensureCudaRuntimeHardlinks(join(resources, 'engine'), join(resources, 'bin'))
}

/**
 * Remove duplicate CUDA runtime copies from dist/engine/ when bin/ already has them.
 * Prefer ensureCudaRuntimeHardlinks after this for local Windows dev trees.
 * @param {string} root Omega repo root
 * @returns {StripResult}
 */
export function stripDuplicateCudaRuntimeFromEngine(root) {
  const binRoot = join(root, 'dist', 'bin')
  const engineRoot = join(root, 'dist', 'engine')
  if (!existsSync(engineRoot)) {
    return { removed: [], freedMb: 0 }
  }

  /** @type {Map<string, string>} lower -> actual bin filename */
  const binRuntime = new Map()
  if (existsSync(binRoot)) {
    for (const name of readdirSync(binRoot)) {
      const p = join(binRoot, name)
      if (!statSync(p).isFile() || !isCudaRuntimeDll(name)) continue
      binRuntime.set(name.toLowerCase(), name)
    }
  }

  const removed = []
  let freed = 0
  for (const name of readdirSync(engineRoot)) {
    const p = join(engineRoot, name)
    if (!statSync(p).isFile() || !isCudaRuntimeDll(name)) continue
    if (!binRuntime.has(name.toLowerCase())) continue
    freed += statSync(p).size
    unlinkSync(p)
    removed.push(name)
  }

  return { removed, freedMb: Math.round(freed / 1024 / 1024) }
}
