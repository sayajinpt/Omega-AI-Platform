/**
 * Detect installed NVIDIA CUDA toolkit major/minor and pick matching
 * llama.cpp prebuilt assets (e.g. cuda-13.1 vs cuda-12.4).
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{ major: number, minor: number, label: string, source: string }} CudaInstallInfo */

/** @param {string} text */
function parseNvccVersion(text) {
  const m = text.match(/release\s+(\d+)\.(\d+)/i)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

/** @param {string} dirName e.g. v13.2 */
function parseCudaDirVersion(dirName) {
  const m = dirName.match(/^v?(\d+)\.(\d+)/i)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

/** @returns {CudaInstallInfo | null} */
function detectFromNvcc() {
  try {
    const out = execSync('nvcc --version', { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const v = parseNvccVersion(out)
    if (!v) return null
    return {
      ...v,
      label: `CUDA ${v.major}.${v.minor}`,
      source: 'nvcc'
    }
  } catch {
    return null
  }
}

/** @returns {CudaInstallInfo | null} */
function detectFromEnvPath() {
  const raw = process.env.CUDA_PATH || process.env.CUDA_HOME || ''
  if (!raw) return null
  const v = parseCudaDirVersion(raw.split(/[/\\]/).pop() ?? '')
  if (!v) return null
  return {
    ...v,
    label: `CUDA ${v.major}.${v.minor} (${raw})`,
    source: 'CUDA_PATH'
  }
}

/** @returns {CudaInstallInfo | null} */
function detectFromToolkitDirs() {
  const roots =
    process.platform === 'win32'
      ? ['C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA']
      : ['/usr/local', '/opt/cuda']
  let best = /** @type {CudaInstallInfo | null} */ (null)
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const v = parseCudaDirVersion(e.name)
      if (!v) continue
      const info = {
        ...v,
        label: `CUDA ${v.major}.${v.minor}`,
        source: `toolkit:${join(root, e.name)}`
      }
      if (!best || v.major > best.major || (v.major === best.major && v.minor > best.minor)) {
        best = info
      }
    }
  }
  if (best) return best
  const versionTxt = '/usr/local/cuda/version.txt'
  if (existsSync(versionTxt)) {
    const v = parseNvccVersion(readFileSync(versionTxt, 'utf8'))
    if (v) {
      return { ...v, label: `CUDA ${v.major}.${v.minor}`, source: 'version.txt' }
    }
  }
  return null
}

/** Detect highest installed CUDA toolkit (not driver-only). */
export function detectInstalledCuda() {
  const chain = [detectFromNvcc, detectFromEnvPath, detectFromToolkitDirs]
  let best = /** @type {CudaInstallInfo | null} */ (null)
  for (const fn of chain) {
    const hit = fn()
    if (!hit) continue
    if (!best || hit.major > best.major || (hit.major === best.major && hit.minor > best.minor)) {
      best = hit
    }
  }
  return best
}

/**
 * @param {{ name: string }[]} assets
 * @param {'llama' | 'cudart'} kind
 */
function parseCudaZipAssets(assets, kind) {
  const re =
    kind === 'llama'
      ? /^llama-.*bin-(win|linux|ubuntu)-cuda-(\d+)\.(\d+)-(x64|arm64)\.(zip|tar\.gz)$/i
      : /^cudart-.*bin-(win|linux|ubuntu)-cuda-(\d+)\.(\d+)-(x64|arm64)\.zip$/i
  const out = []
  for (const asset of assets) {
    const m = asset.name.match(re)
    if (!m) continue
    const plat = m[1].toLowerCase() === 'ubuntu' ? 'linux' : m[1].toLowerCase()
    out.push({
      asset,
      platform: plat,
      major: Number(m[2]),
      minor: Number(m[3]),
      arch: m[4].toLowerCase()
    })
  }
  return out
}

/**
 * Pick the best CUDA llama.cpp zip for this OS/arch and installed CUDA major.
 * @param {{ name: string }[]} assets
 * @param {{ platform: 'win' | 'linux', arch?: string, cuda?: CudaInstallInfo | null }} opts
 * @returns {{ name: string, browser_download_url: string } | null}
 */
export function pickCudaLlamaAsset(assets, opts) {
  const arch = opts.arch ?? 'x64'
  const all = parseCudaZipAssets(assets, 'llama').filter(
    (c) => c.platform === opts.platform && c.arch === arch
  )
  if (!all.length) return null

  const cuda = opts.cuda ?? detectInstalledCuda()
  let pool = all
  if (cuda) {
    const sameMajor = all.filter((c) => c.major === cuda.major)
    if (sameMajor.length) {
      pool = sameMajor
      console.log(
        `[cuda-detect] Installed ${cuda.label} (${cuda.source}) → llama.cpp CUDA ${cuda.major}.x binaries`
      )
    } else {
      const majors = [...new Set(all.map((c) => c.major))].sort((a, b) => b - a)
      const fallback = majors[0]
      pool = all.filter((c) => c.major === fallback)
      console.log(
        `[cuda-detect] Installed ${cuda.label} but no CUDA ${cuda.major}.x build on this release; using CUDA ${fallback}.x (driver backward-compatible)`
      )
    }
  } else {
    console.log('[cuda-detect] CUDA toolkit not detected — using newest CUDA build on release')
  }

  pool.sort((a, b) => b.minor - a.minor || b.major - a.major)
  const pick = pool[0]
  if (pick) {
    console.log(`[cuda-detect] Selected: ${pick.asset.name}`)
  }
  return pick?.asset ?? null
}

/**
 * @param {{ name: string }[]} assets
 * @param {'win' | 'linux'} platform
 * @param {CudaInstallInfo | null} cuda
 * @param {string} [arch]
 */
export function pickCudartAsset(assets, platform, cuda, arch = 'x64') {
  const all = parseCudaZipAssets(assets, 'cudart').filter(
    (c) => c.platform === platform && c.arch === arch
  )
  if (!all.length) return null
  let pool = all
  if (cuda) {
    const sameMajor = all.filter((c) => c.major === cuda.major)
    if (sameMajor.length) pool = sameMajor
  }
  pool.sort((a, b) => b.minor - a.minor || b.major - a.major)
  return pool[0]?.asset ?? null
}
