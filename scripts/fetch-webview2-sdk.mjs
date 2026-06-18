#!/usr/bin/env node
/**
 * Download Microsoft.Web.WebView2 NuGet package for apps/shell (headers + loader lib).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { execSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'apps', 'shell', 'third_party', 'webview2')
const marker = join(outDir, '.version')
const VERSION = process.env.OMEGA_WEBVIEW2_VERSION ?? '1.0.2903.40'

if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === VERSION) {
  console.log('[fetch-webview2] up to date', VERSION)
  process.exit(0)
}

const url = `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${VERSION}`
const zipPath = join(outDir, 'webview2.zip')

mkdirSync(outDir, { recursive: true })
console.log('[fetch-webview2] downloading', url)

const res = await fetch(url)
if (!res.ok) throw new Error(`download failed ${res.status}`)
await pipeline(res.body, createWriteStream(zipPath))

if (existsSync(join(outDir, 'build'))) rmSync(join(outDir, 'build'), { recursive: true, force: true })

execSync(
  `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force"`,
  { stdio: 'inherit' }
)

writeFileSync(marker, VERSION + '\n')
console.log('[fetch-webview2] OK ->', outDir)
