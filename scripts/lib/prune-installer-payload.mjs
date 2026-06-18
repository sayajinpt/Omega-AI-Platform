/**
 * Shrink native installer payloads (NSIS ~2 GB limit).
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { detectInstalledCuda } from './cuda-detect.mjs'
import { readPrimaryVariant } from './llama-lock.mjs'

/** @param {string} dir */
function dirSizeMb(dir) {
  if (!existsSync(dir)) return 0
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

/**
 * Drop inactive CUDA major DLLs from promoted dist/bin (omega-infer zip ships 12 + 13).
 * @param {string} root Omega repo root
 */
export function pruneInactiveCudaDlls(root) {
  const binRoot = join(root, 'dist', 'bin')
  if (!existsSync(binRoot)) return { removed: [], freedMb: 0, keepMajor: null }

  const { variant } = readPrimaryVariant(root)
  if (variant?.gpu !== 'cuda') return { removed: [], freedMb: 0, keepMajor: null }

  let keepMajor = 13
  const manifest = join(root, 'dist', 'llama-build.json')
  if (existsSync(manifest)) {
    try {
      const j = JSON.parse(readFileSync(manifest, 'utf8'))
      if (j.cudaMajor === 12 || j.cudaMajor === 13) keepMajor = j.cudaMajor
    } catch {
      /* use detect */
    }
  }
  const cuda = detectInstalledCuda()
  if (cuda?.major === 12 || cuda?.major === 13) keepMajor = cuda.major

  const dropMajor = keepMajor === 13 ? 12 : 13
  const removed = []
  let freed = 0
  for (const name of readdirSync(binRoot)) {
    const p = join(binRoot, name)
    if (!statSync(p).isFile()) continue
    const lower = name.toLowerCase()
    const hit =
      lower.includes(`_${dropMajor}.`) ||
      lower.includes(`_${dropMajor}_`) ||
      (dropMajor === 12 && /cublas.*12/i.test(name)) ||
      (dropMajor === 13 && /cublas.*13/i.test(name))
    if (!hit) continue
    freed += statSync(p).size
    unlinkSync(p)
    removed.push(name)
  }
  return { removed, freedMb: Math.round(freed / 1024 / 1024), keepMajor, dropMajor }
}

/** CPU runners kept when trimming ggml-cpu-* variants. */
export const GGML_CPU_KEEP = new Set([
  'ggml-cpu-x64.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-zen4.dll',
  'ggml-cpu-alderlake.dll'
])

/**
 * @param {string} root
 */
export function pruneGgmlCpuVariants(root) {
  const binRoot = join(root, 'dist', 'bin')
  if (!existsSync(binRoot)) return { removed: [], freedMb: 0 }

  const removed = []
  let freed = 0
  for (const name of readdirSync(binRoot)) {
    if (!/^ggml-cpu-.+\.dll$/i.test(name)) continue
    if (GGML_CPU_KEEP.has(name)) continue
    const p = join(binRoot, name)
    freed += statSync(p).size
    unlinkSync(p)
    removed.push(name)
  }
  return { removed, freedMb: Math.round(freed / 1024 / 1024) }
}

/**
 * @param {string} root
 */
export function pruneInstallerPayload(root) {
  const cuda = pruneInactiveCudaDlls(root)
  const cpu = pruneGgmlCpuVariants(root)
  return { cuda, cpu }
}
