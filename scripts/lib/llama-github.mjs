/**
 * GitHub API + source download for ggml-org/llama.cpp
 */
import { execSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const LLAMA_CPP_REPO = 'ggml-org/llama.cpp'
export const LLAMA_CPP_REPO_URL = 'https://github.com/ggml-org/llama.cpp'

const GH_HEADERS = {
  'User-Agent': 'Omega-Setup',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function githubHeaders() {
  const headers = { ...GH_HEADERS }
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/** @param {string | null} linkHeader */
function nextLinkUrl(linkHeader) {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/)
    if (m) return m[1]
  }
  return null
}

/** @param {{ name?: string }[]} assets */
export function looksLikeIncompleteWindowsAssets(assets) {
  if (process.platform !== 'win32' || !assets.length) return false
  const hasLlamaWinCuda = assets.some((a) => /^llama-.*bin-win-cuda-\d+\.\d+-x64\.zip$/i.test(a.name ?? ''))
  const hasLlamaWinVulkan = assets.some((a) => /^llama-.*bin-win-vulkan-x64\.zip$/i.test(a.name ?? ''))
  if (hasLlamaWinCuda && hasLlamaWinVulkan) return false
  const hasLinuxVulkan = assets.some((a) => /llama-.*bin-ubuntu-vulkan-x64\.tar\.gz$/i.test(a.name ?? ''))
  const hasCudartWin = assets.some((a) => /^cudart-.*bin-win-cuda-/i.test(a.name ?? ''))
  const hasWinCpu = assets.some((a) => /^llama-.*bin-win-cpu-x64\.zip$/i.test(a.name ?? ''))
  return hasLinuxVulkan || hasCudartWin || hasWinCpu
}

/**
 * GitHub may return a truncated `release.assets` array; always hydrate from assets_url.
 * @param {{ assets?: { id?: number, name: string }[], assets_url?: string }} release
 * @param {{ retries?: number, quiet?: boolean }} [opts]
 */
export async function fetchAllReleaseAssets(release, opts = {}) {
  const { retries = 3, quiet = false } = opts
  const log = (msg) => {
    if (!quiet) console.warn(msg)
  }
  const inline = Array.isArray(release.assets) ? release.assets : []
  if (!release.assets_url) return inline

  const merged = []
  const seen = new Set()
  const addPage = (page) => {
    if (!Array.isArray(page)) return
    for (const asset of page) {
      const key = asset.id ?? asset.name
      if (key == null || seen.has(key)) continue
      seen.add(key)
      merged.push(asset)
    }
  }

  let url = release.assets_url.includes('?')
    ? `${release.assets_url}&per_page=100`
    : `${release.assets_url}?per_page=100`

  for (let attempt = 0; attempt < retries && url; attempt++) {
    try {
      const res = await fetch(url, { headers: githubHeaders() })
      if (!res.ok) {
        log(`[llama-github] assets list ${res.status} — using inline assets (${inline.length})`)
        addPage(inline)
        break
      }
      addPage(await res.json())
      url = nextLinkUrl(res.headers.get('link') ?? '')
    } catch (err) {
      log(`[llama-github] assets fetch error: ${err instanceof Error ? err.message : err}`)
      if (attempt + 1 < retries) {
        await sleep(Math.min(20_000, 1500 * 2 ** attempt))
        continue
      }
      addPage(inline)
      break
    }
  }

  const assets = merged.length ? merged : inline
  if (assets.length > inline.length) {
    log(`[llama-github] loaded ${assets.length} release assets (${inline.length} from release JSON)`)
  }
  return assets
}

function releaseApiUrl(tag) {
  const norm = tag === 'latest' || !tag ? 'latest' : normalizeTag(tag)
  return norm === 'latest'
    ? `https://api.github.com/repos/${LLAMA_CPP_REPO}/releases/latest`
    : `https://api.github.com/repos/${LLAMA_CPP_REPO}/releases/tags/${norm}`
}

function envPinnedTag() {
  const raw = process.env.OMEGA_LLAMA_TAG?.trim()
  return raw ? normalizeTag(raw) : null
}

function lockedTag(root) {
  if (!root) return null
  const lock = readSetupLock(root)
  const tag = lock?.tag?.trim()
  return tag ? normalizeTag(tag) : null
}

/**
 * @param {string} tag `latest` or `b9253`
 * @param {{ root?: string, retries?: number, quiet?: boolean }} [opts]
 */
export async function fetchRelease(tag = 'latest', opts = {}) {
  const { root, retries = 5, quiet = false } = opts
  const log = (msg) => {
    if (!quiet) console.warn(msg)
  }

  let resolvedTag = tag === 'latest' || !tag ? 'latest' : normalizeTag(tag)
  const pinned = envPinnedTag()
  if (resolvedTag === 'latest' && pinned) {
    log(`[llama-github] OMEGA_LLAMA_TAG=${pinned} — skipping /releases/latest`)
    resolvedTag = pinned
  }

  const fetchOnce = async (apiTag) => {
    const url = releaseApiUrl(apiTag)
    let lastError = null
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, { headers: githubHeaders() })
        if (res.ok) {
          return /** @type {Promise<{ tag_name: string, name: string, published_at: string, html_url: string, assets_url?: string, assets: { name: string, browser_download_url: string, size: number }[] }>} */ (
            res.json()
          )
        }
        lastError = new Error(`GitHub API ${res.status} for ${url}`)
        if (isRetryableStatus(res.status) && attempt + 1 < retries) {
          const wait = Math.min(20_000, 1500 * 2 ** attempt)
          log(`[llama-github] ${res.status} from GitHub — retry ${attempt + 2}/${retries} in ${wait}ms…`)
          await sleep(wait)
          continue
        }
        throw lastError
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('GitHub API ')) throw err
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt + 1 < retries) {
          const wait = Math.min(20_000, 1500 * 2 ** attempt)
          log(
            `[llama-github] Network error (${lastError.message}) — retry ${attempt + 2}/${retries} in ${wait}ms…`
          )
          await sleep(wait)
          continue
        }
        throw lastError
      }
    }
    throw lastError ?? new Error(`GitHub API failed for ${url}`)
  }

  const hydrateRelease = async (raw) => {
    let assets = await fetchAllReleaseAssets(raw, { retries, quiet })
    if (looksLikeIncompleteWindowsAssets(assets)) {
      for (let attempt = 0; attempt < retries; attempt++) {
        log(
          `[llama-github] ${raw.tag_name}: ${assets.length} assets but Windows CUDA/Vulkan zips missing — refetching (${attempt + 1}/${retries})…`
        )
        await sleep(Math.min(20_000, 1500 * 2 ** attempt))
        assets = await fetchAllReleaseAssets(raw, { retries: 1, quiet })
        if (!looksLikeIncompleteWindowsAssets(assets)) break
      }
    }
    if (!assets.length) {
      log(`[llama-github] Warning: release ${raw.tag_name} returned no assets from GitHub API`)
    }
    return { ...raw, assets }
  }

  try {
    return await hydrateRelease(await fetchOnce(resolvedTag))
  } catch (firstErr) {
    const wantsLatest = tag === 'latest' || !tag
    if (!wantsLatest || resolvedTag !== 'latest') throw firstErr

    const fallbacks = []
    const fromLock = lockedTag(root)
    if (fromLock) fallbacks.push(fromLock)

    for (const fb of fallbacks) {
      try {
        log(`[llama-github] /releases/latest unavailable — trying locked tag ${fb}`)
        return await hydrateRelease(await fetchOnce(fb))
      } catch {
        /* try next fallback */
      }
    }

    const hintTag = fromLock ?? 'b9637'
    const base = firstErr instanceof Error ? firstErr.message : String(firstErr)
    throw new Error(
      `${base}\n` +
        '  GitHub releases API is unreachable or rate-limited. You can:\n' +
        '  • Wait a minute and run build.bat again (transient 502/504 errors)\n' +
        `  • Set OMEGA_LLAMA_TAG=${hintTag} and retry\n` +
        `  • Run: node scripts/llama-setup.mjs --tag=${hintTag} --installer`
    )
  }
}

/** @param {string} tag */
export function normalizeTag(tag) {
  const t = tag.trim()
  if (!t || /^latest$/i.test(t)) return 'latest'
  return t.startsWith('b') ? t : `b${t}`
}

/** @param {string} root @param {string} tag */
export function sourceCacheDir(root, tag) {
  return join(root, '.omega', 'cache', 'llama.cpp-src', normalizeTag(tag))
}

/** @param {string} root */
export function setupLockPath(root) {
  return join(root, '.omega', 'llama-setup.json')
}

/** @param {string} root */
export function readSetupLock(root) {
  const p = setupLockPath(root)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} root @param {object} data */
export function writeSetupLock(root, data) {
  const p = setupLockPath(root)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/**
 * Download release source tarball into cache. Returns path with CMakeLists.txt.
 * @param {string} root
 * @param {string} tag
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureSourceTree(root, tag, opts = {}) {
  const norm = normalizeTag(tag)
  if (norm === 'latest') {
    throw new Error('ensureSourceTree needs a concrete tag (e.g. b9668), not "latest"')
  }
  const cache = sourceCacheDir(root, norm)
  if (!opts.force && existsSync(join(cache, 'CMakeLists.txt'))) {
    return cache
  }

  if (existsSync(cache)) rmSync(cache, { recursive: true, force: true })
  mkdirSync(dirname(cache), { recursive: true })

  const url = `${LLAMA_CPP_REPO_URL}/archive/refs/tags/${norm}.zip`
  const zipPath = join(tmpdir(), `omega-llama-src-${norm}-${Date.now()}.zip`)
  const extractRoot = join(tmpdir(), `omega-llama-src-extract-${Date.now()}`)

  console.log(`[llama-github] Downloading source ${norm}…`)
  await downloadFile(url, zipPath)
  unzip(zipPath, extractRoot)

  const entries = readdirSync(extractRoot)
  const folder = entries.find((e) => e.startsWith('llama.cpp'))
  if (!folder) {
    throw new Error(`Expected llama.cpp-${norm} folder in source zip`)
  }

  const src = join(extractRoot, folder)
  cpTree(src, cache)
  try {
    rmSync(extractRoot, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  } catch {
    /* ignore */
  }

  if (!existsSync(join(cache, 'CMakeLists.txt'))) {
    throw new Error(`Invalid source tree at ${cache}`)
  }

  console.log(`[llama-github] Source ready: ${cache}`)
  return cache
}

/** Shallow clone fallback when tarball fails */
export function ensureSourceGit(root, tag) {
  const norm = normalizeTag(tag)
  const cache = sourceCacheDir(root, norm)
  if (existsSync(join(cache, 'CMakeLists.txt'))) return cache

  mkdirSync(dirname(cache), { recursive: true })
  console.log(`[llama-github] Cloning ${LLAMA_CPP_REPO_URL} @ ${norm}…`)
  execSync(
    `git clone --depth 1 --branch ${norm} "${LLAMA_CPP_REPO_URL}.git" "${cache}"`,
    { stdio: 'inherit' }
  )
  return cache
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { headers: GH_HEADERS, redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function unzip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    const z = zipPath.replace(/'/g, "''")
    const d = destDir.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${z}' -DestinationPath '${d}' -Force"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' })
  }
}

function cpTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    execSync(`xcopy "${src}" "${dest}" /E /I /Y /Q`, { stdio: 'ignore' })
  } else {
    execSync(`cp -a "${src}/." "${dest}"`, { stdio: 'inherit' })
  }
}
