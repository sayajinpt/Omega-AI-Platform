/**
 * Download and install one llama.cpp prebuilt asset into dist/bin/<variant>/.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { detectInstalledCuda } from './cuda-detect.mjs'
import { buildInferFromSource } from './build-infer-source.mjs'
import { archiveKind, pickCudartForVariant, pickInferAssetForVariant } from './llama-release-assets.mjs'
import { resolveVariant } from './llama-variants.mjs'

/**
 * @param {string} url
 * @param {string} dest
 */
async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Omega-Build' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`)
  if (!res.body) throw new Error(`No response body: ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 */
function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const kind = archiveKind(archivePath)
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      const z = archivePath.replace(/'/g, "''")
      const d = destDir.replace(/'/g, "''")
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${z}' -DestinationPath '${d}' -Force"`,
        { stdio: 'inherit' }
      )
    } else {
      execSync(`unzip -o -q "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' })
    }
    return
  }
  if (kind === 'tar.gz') {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' })
    return
  }
  throw new Error(`Unsupported archive: ${archivePath}`)
}

/**
 * @param {string} url
 * @param {string} label
 */
async function downloadAndExtract(url, label) {
  const safe = label.replace(/[^\w.-]+/g, '_')
  const ext = /\.tar\.gz$/i.test(label) ? '.tar.gz' : '.zip'
  const archivePath = join(tmpdir(), `omega-llama-${safe}-${Date.now()}${ext}`)
  const extractDir = join(tmpdir(), `omega-llama-extract-${safe}-${Date.now()}`)
  console.log(`[fetch-infer] Downloading ${label}…`)
  await download(url, archivePath)
  extractArchive(archivePath, extractDir)
  return extractDir
}

function walkFind(dir, fileName) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      const hit = walkFind(p, fileName)
      if (hit) return hit
    } else if (ent.name === fileName) {
      return p
    }
  }
  return null
}

function walkLibs(dir, pattern) {
  const ext = pattern === '*.dll' ? '.dll' : '.so'
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkLibs(p, pattern))
    else if (ent.name.endsWith(ext) || (ext === '.so' && ent.name.includes('.so'))) out.push(p)
  }
  return out
}

function namesForHost() {
  if (process.platform === 'win32') {
    return {
      server: 'llama-server.exe',
      quant: 'llama-quantize.exe',
      outServer: 'omega-infer.exe',
      outQuant: 'llama-quantize.exe',
      libGlob: '*.dll'
    }
  }
  return {
    server: 'llama-server',
    quant: 'llama-quantize',
    outServer: 'omega-infer',
    outQuant: 'llama-quantize',
    libGlob: '*.so*'
  }
}

/**
 * @param {object} opts
 * @param {string} opts.root Omega repo root
 * @param {import('./llama-variants.mjs').LlamaVariant} opts.variant
 * @param {{ tag_name: string, assets: { name: string, browser_download_url: string }[] }} opts.release
 * @param {boolean} [opts.force]
 * @param {import('./cuda-detect.mjs').CudaInstallInfo | null} [opts.cuda]
 */
export async function installInferVariant(opts) {
  const { root, variant, release, force = false, cuda = detectInstalledCuda() } = opts
  const binDir = join(root, 'dist', 'bin', variant.inferSubdir)
  const stampFile = join(binDir, '.fetch-stamp')
  const n = namesForHost()
  const inferPath = join(binDir, n.outServer)
  const quantPath = join(binDir, n.outQuant)

  mkdirSync(binDir, { recursive: true })

  if (existsSync(inferPath) && existsSync(quantPath) && !force) {
    console.log(`[fetch-infer] ${variant.id}: already present (use --force)`)
    return { skipped: true, binDir }
  }

  const mainAsset = pickInferAssetForVariant(release.assets ?? [], variant, cuda)
  if (!mainAsset) {
    console.warn(
      `[fetch-infer] No prebuilt asset for ${variant.label} on ${release.tag_name} — building from source (needs cmake + GPU SDK)…`
    )
    return buildInferFromSource({ root, variant, force, tag: release.tag_name })
  }

  const extractDir = await downloadAndExtract(mainAsset.browser_download_url, mainAsset.name)

  if (variant.gpu === 'cuda' && variant.platform === 'win') {
    const cudart = pickCudartForVariant(release.assets ?? [], variant, cuda)
    if (cudart) {
      const cudartDir = await downloadAndExtract(cudart.browser_download_url, cudart.name)
      for (const dll of walkLibs(cudartDir, '*.dll')) {
        copyFileSync(dll, join(extractDir, dll.split(/[/\\]/).pop()))
      }
    }
  }

  const server = walkFind(extractDir, n.server)
  let quant = walkFind(extractDir, n.quant)
  if (!server) {
    throw new Error(`${n.server} not found in ${mainAsset.name}`)
  }
  if (!quant) {
    for (const a of release.assets ?? []) {
      if (!/quantize/i.test(a.name)) continue
      const qdir = await downloadAndExtract(a.browser_download_url, a.name)
      quant = walkFind(qdir, n.quant)
      if (quant) break
    }
  }
  if (!quant) throw new Error(`${n.quant} not found`)

  copyFileSync(server, inferPath)
  copyFileSync(quant, quantPath)
  for (const lib of walkLibs(dirname(server), n.libGlob)) {
    copyFileSync(lib, join(binDir, lib.split(/[/\\]/).pop()))
  }
  for (const lib of walkLibs(extractDir, n.libGlob)) {
    const dest = join(binDir, lib.split(/[/\\]/).pop())
    if (!existsSync(dest)) copyFileSync(lib, dest)
  }
  if (process.platform !== 'win32') {
    try {
      execSync(`chmod +x "${inferPath}" "${quantPath}"`, { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  }

  writeFileSync(
    stampFile,
    JSON.stringify(
      { tag: release.tag_name, main: mainAsset.name, variant: variant.id, fetched: new Date().toISOString() },
      null,
      2
    )
  )
  console.log(`[fetch-infer] ${variant.id}: installed → ${binDir}`)
  return { skipped: false, binDir, asset: mainAsset.name }
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {{ tag_name: string, assets: unknown[] }} opts.release
 * @param {string[]} opts.variantIds
 * @param {boolean} [opts.force]
 */
export async function installAllHostVariants(opts) {
  const { root, release, variantIds, force = false } = opts
  const cuda = detectInstalledCuda()
  const results = []
  for (const id of variantIds) {
    const variant = resolveVariant(id)
    console.log(`\n[fetch-infer] === ${variant.label} (${release.tag_name}) ===`)
    try {
      const r = await installInferVariant({ root, variant, release, force, cuda })
      results.push({ id, ok: true, ...r })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fetch-infer] ${id}: skipped — ${msg}`)
      results.push({ id, ok: false, error: msg })
    }
  }
  return results
}
