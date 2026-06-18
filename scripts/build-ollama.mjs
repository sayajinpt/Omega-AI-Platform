#!/usr/bin/env node
/**
 * Produces a bundled Ollama runtime for Omega.
 *
 * Strategy:
 *  1. If go + gcc + cmake are present, build from the bundled source tree
 *     (../../../ollama-0.30.0-rc20). This is preferred — full provenance,
 *     no network dependency.
 *  2. Otherwise download the matching prebuilt release binary from GitHub
 *     (MIT-licensed) so the developer machine can still produce a working
 *     installer without the full toolchain.
 *
 * Output: dist/bin/omega-ollama(.exe) — picked up by native packaging under dist/native/Omega/bin/
 */
import { execSync, spawnSync } from 'node:child_process'
import { createWriteStream, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const workspaceRoot = resolve(repoRoot, '..')
const sourceDir = join(workspaceRoot, 'ollama-0.30.0-rc20')
const binDir = join(repoRoot, 'dist', 'bin')
// Pin to a known-good public release. The bundled source tree may be a
// future/internal RC that hasn't been published yet — for the prebuilt fallback
// we always grab the latest stable from GitHub releases.
const OLLAMA_FALLBACK_VERSION = '0.24.0'
const exeName = process.platform === 'win32' ? 'omega-ollama.exe' : 'omega-ollama'
const outPath = join(binDir, exeName)

if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })

function have(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
  return r.status === 0
}

async function tryBuildFromSource() {
  if (!existsSync(sourceDir)) return { ok: false, reason: 'source folder missing' }
  if (!have('go')) return { ok: false, reason: 'go not on PATH' }
  if (process.platform === 'win32') {
    if (!have('gcc') && !have('cl')) return { ok: false, reason: 'no C compiler (gcc/cl) on PATH' }
  } else if (!have('cc')) {
    return { ok: false, reason: 'no C compiler on PATH' }
  }
  console.log('[ollama] building from bundled source…')
  try {
    execSync(`go build -tags="no_mlx" -o "${outPath}" .`, {
      cwd: sourceDir,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '1' }
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) }
  }
}

async function resolveLatestVersion() {
  try {
    const r = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
      headers: { 'User-Agent': 'omega-build' }
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (typeof j.tag_name === 'string') return j.tag_name.replace(/^v/, '')
  } catch (e) {
    console.log(`[ollama] latest-release lookup failed (${e?.message ?? e}) — using ${OLLAMA_FALLBACK_VERSION}`)
  }
  return OLLAMA_FALLBACK_VERSION
}

async function downloadPrebuilt() {
  const plat = process.platform
  const arch = process.arch
  let asset
  if (plat === 'win32' && arch === 'x64') {
    asset = 'ollama-windows-amd64.zip'
  } else if (plat === 'win32' && arch === 'arm64') {
    asset = 'ollama-windows-arm64.zip'
  } else if (plat === 'darwin') {
    asset = 'Ollama-darwin.zip'
  } else if (plat === 'linux' && arch === 'x64') {
    asset = 'ollama-linux-amd64.tar.zst'
  } else if (plat === 'linux' && arch === 'arm64') {
    asset = 'ollama-linux-arm64.tar.zst'
  } else {
    throw new Error(`no prebuilt mapping for ${plat}/${arch}`)
  }
  const version = await resolveLatestVersion()
  const url = `https://github.com/ollama/ollama/releases/download/v${version}/${asset}`
  console.log(`[ollama] downloading prebuilt: ${url}`)
  const tmp = join(binDir, `_dl_${asset}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`)
  await new Promise((resolveP, rejectP) => {
    const ws = createWriteStream(tmp)
    Readable.fromWeb(res.body).pipe(ws)
    ws.on('finish', () => resolveP())
    ws.on('error', rejectP)
  })
  console.log(`[ollama] extracting ${asset} (${(statSync(tmp).size / 1024 / 1024).toFixed(1)} MB)…`)
  // Extract — Windows uses Expand-Archive, Unix uses tar/unzip
  const extractDir = join(binDir, '_extract')
  if (existsSync(extractDir)) {
    try {
      rmSync(extractDir, { recursive: true, force: true })
    } catch (e) {
      // Windows: if a shell is sitting inside the dir, retry from a different cwd
      process.chdir(binDir)
      rmSync(extractDir, { recursive: true, force: true })
    }
  }
  mkdirSync(extractDir, { recursive: true })
  if (asset.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(
        `powershell.exe -NoProfile -Command "Expand-Archive -Path '${tmp}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'inherit' }
      )
    } else {
      execSync(`unzip -o "${tmp}" -d "${extractDir}"`, { stdio: 'inherit' })
    }
  } else if (asset.endsWith('.tar.zst')) {
    // Needs zstd + tar (both present on modern Linux distros)
    execSync(`tar --use-compress-program=unzstd -xf "${tmp}" -C "${extractDir}"`, { stdio: 'inherit' })
  } else if (asset.endsWith('.tar.gz') || asset.endsWith('.tgz')) {
    execSync(`tar -xzf "${tmp}" -C "${extractDir}"`, { stdio: 'inherit' })
  } else {
    throw new Error(`don't know how to extract ${asset}`)
  }
  // Find the ollama executable inside extractDir
  const candidates = [
    join(extractDir, 'ollama.exe'),
    join(extractDir, 'bin', 'ollama.exe'),
    join(extractDir, 'ollama'),
    join(extractDir, 'bin', 'ollama'),
    join(extractDir, 'ollama-windows-amd64', 'ollama.exe')
  ]
  const found = candidates.find((c) => existsSync(c))
  if (!found) throw new Error(`could not locate ollama binary inside ${extractDir}`)
  if (existsSync(outPath)) await unlink(outPath).catch(() => {})
  await rename(found, outPath)

  // The Ollama runtime looks for sibling `lib/ollama/*` (CPU runners + GPU
  // backends). Copy only what we need to keep the installer small. node-llama-cpp
  // already handles GGUF CUDA, so Ollama's job is non-GGUF inference and CPU
  // + Vulkan is enough — Vulkan works on both AMD and NVIDIA. Users who want
  // dedicated CUDA acceleration in Ollama can re-run with INCLUDE_CUDA=1.
  const libSrcRoot = (() => {
    const c = [
      join(dirname(found), 'lib', 'ollama'),
      join(extractDir, 'lib', 'ollama'),
      join(extractDir, 'ollama-windows-amd64', 'lib', 'ollama')
    ]
    return c.find((p) => existsSync(p))
  })()
  if (libSrcRoot) {
    const libDest = join(binDir, 'lib', 'ollama')
    if (existsSync(libDest)) rmSync(libDest, { recursive: true, force: true })
    mkdirSync(libDest, { recursive: true })

    const includeCuda = process.env.INCLUDE_CUDA === '1'
    // Always copy top-level CPU runners (small, ~10 MB)
    cpSync(libSrcRoot, libDest, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(libSrcRoot.length + 1).replace(/\\/g, '/')
        if (!rel) return true
        const top = rel.split('/')[0]
        // top-level files (ggml-cpu-*.dll, ggml-base.dll, etc.) — always keep
        if (!rel.includes('/')) return true
        // GPU backend subdirs: keep contents only for backends we want
        if (top === 'vulkan' || top === 'metal') return true
        if (top.startsWith('cuda_')) return includeCuda
        if (top.startsWith('rocm')) return false
        return true
      }
    })
    // Remove any backend subdirs that ended up empty (e.g. cuda_v12/ with no children)
    for (const sub of ['cuda_v12', 'cuda_v13', 'rocm']) {
      const p = join(libDest, sub)
      if (existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
    console.log(
      `[ollama] copied runners → ${libDest}${includeCuda ? ' (with CUDA)' : ' (CPU + Vulkan; set INCLUDE_CUDA=1 to add CUDA, +~3 GB)'}`
    )
  } else {
    console.log('[ollama] no lib/ollama tree found in archive — runtime may be a single-file build')
  }

  await unlink(tmp).catch(() => {})
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
  console.log(`[ollama] installed → ${outPath}`)
}

;(async () => {
  if (existsSync(outPath) && process.env.FORCE !== '1') {
    console.log(`[ollama] reusing existing ${outPath} (set FORCE=1 to rebuild)`)
    return
  }
  const built = await tryBuildFromSource()
  if (built.ok) {
    console.log(`[ollama] built from source → ${outPath}`)
    return
  }
  console.log(`[ollama] source build skipped (${built.reason}) — falling back to prebuilt`)
  await downloadPrebuilt()
})().catch((e) => {
  console.error(`[ollama] failed: ${e?.message ?? e}`)
  process.exit(1)
})
