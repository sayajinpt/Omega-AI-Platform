#!/usr/bin/env node
/**
 * Build an AppImage from dist/native/Omega (Linux only).
 * Requires appimagetool on PATH or downloads a local copy under tools/.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const layoutRoot = join(root, 'dist', 'native', 'Omega')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.1.0'
const appDir = join(root, 'dist', 'native', 'Omega.AppDir')
const outImage = join(root, 'dist', 'native', `Omega-${version}-x86_64.AppImage`)

if (process.platform !== 'linux') {
  console.error('[package-appimage] run on Linux only (needs appimagetool + FUSE)')
  process.exit(1)
}

if (!existsSync(join(layoutRoot, 'omega-desktop'))) {
  console.error('[package-appimage] missing dist/native/Omega/omega-desktop — run: npm run build:linux')
  process.exit(1)
}

function stageAppDir() {
  if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
  mkdirSync(appDir, { recursive: true })
  cpSync(layoutRoot, appDir, { recursive: true })

  const iconSrc = join(root, 'apps', 'desktop', 'resources', 'icon.png')
  if (existsSync(iconSrc)) {
    copyFileSync(iconSrc, join(appDir, 'Omega.png'))
    copyFileSync(iconSrc, join(appDir, '.DirIcon'))
  }

  writeFileSync(
    join(appDir, 'omega.desktop'),
    `[Desktop Entry]
Type=Application
Name=Omega
Comment=Local AI operating system
Exec=omega-desktop
Icon=Omega
Categories=Development;Utility;
Terminal=false
StartupWMClass=omega-desktop
`,
    'utf8',
  )

  writeFileSync(
    join(appDir, 'AppRun'),
    `#!/bin/sh
set -eu
APPDIR="$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")"
cd "$APPDIR"
export PATH="$APPDIR/bin:$PATH"
exec "$APPDIR/omega-desktop" "$@"
`,
    'utf8',
  )
  chmodSync(join(appDir, 'AppRun'), 0o755)
  chmodSync(join(appDir, 'omega-desktop'), 0o755)
}

async function downloadAppImageTool(dest) {
  const url =
    'https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage'
  console.log('[package-appimage] downloading appimagetool…')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  chmodSync(dest, 0o755)
}

function resolveAppImageTool() {
  const local = join(root, 'tools', 'appimagetool-x86_64.AppImage')
  const fromPath = spawnSync('appimagetool', ['--version'], { encoding: 'utf8' })
  if (fromPath.status === 0) return { cmd: 'appimagetool', args: [] }
  if (existsSync(local)) return { cmd: local, args: [] }
  return { cmd: local, args: [], download: true }
}

async function main() {
  stageAppDir()
  let tool = resolveAppImageTool()
  if (tool.download) {
    await downloadAppImageTool(tool.cmd)
    tool = { cmd: tool.cmd, args: [] }
  }

  if (existsSync(outImage)) rmSync(outImage, { force: true })

  const env = { ...process.env, ARCH: 'x86_64', VERSION: version }
  const run = spawnSync(tool.cmd, [...tool.args, appDir, outImage], {
    stdio: 'inherit',
    env,
  })
  if (run.status !== 0) {
    console.error('[package-appimage] appimagetool failed')
    process.exit(run.status ?? 1)
  }
  chmodSync(outImage, 0o755)
  console.log('[package-appimage] OK:', outImage)
}

main().catch((err) => {
  console.error('[package-appimage]', err.message || err)
  process.exit(1)
})
