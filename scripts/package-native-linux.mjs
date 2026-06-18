#!/usr/bin/env node
/**
 * Stage Linux Omega layout under dist/native/Omega/
 */
import { cpSync, copyFileSync, existsSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageClaw3dOffice } from './lib/stage-claw3d-resources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellSrc = join(root, 'dist', 'shell')
const outRoot = join(root, 'dist', 'native', 'Omega')

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false
  cpSync(src, dest, { recursive: true })
  return true
}

if (!existsSync(join(shellSrc, 'omega-desktop'))) {
  console.error('[package-native-linux] missing dist/shell/omega-desktop — run: npm run build:shell')
  process.exit(1)
}

if (existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
cpSync(shellSrc, outRoot, { recursive: true })
try {
  chmodSync(join(outRoot, 'omega-desktop'), 0o755)
} catch {
  /* ignore */
}

const resources = join(outRoot, 'resources')
mkdirSync(resources, { recursive: true })
copyIfExists(join(root, 'dist', 'content-studio'), join(resources, 'content-studio'))
copyIfExists(join(root, 'apps', 'desktop', 'content-studio'), join(resources, 'content-studio'))
stageClaw3dOffice(root, resources)
copyIfExists(join(root, 'engines'), join(resources, 'engines'))
copyIfExists(join(root, 'apps', 'desktop', 'scripts'), join(resources, 'scripts'))

const icon = join(root, 'apps', 'desktop', 'resources', 'icon.png')
if (existsSync(icon)) copyFileSync(icon, join(outRoot, 'ui', 'icon.png'))

writeFileSync(
  join(outRoot, 'omega.desktop'),
  `[Desktop Entry]
Type=Application
Name=Omega
Comment=Local AI operating system
Exec=${join(outRoot, 'omega-desktop')}
Icon=${join(outRoot, 'ui', 'icon.png')}
Categories=Development;Utility;
Terminal=false
StartupWMClass=omega-desktop
`,
  'utf8',
)

writeFileSync(
  join(outRoot, 'omega'),
  `#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$ROOT/bin:$PATH"
exec "$ROOT/omega-desktop" "$@"
`,
  'utf8',
)
try {
  chmodSync(join(outRoot, 'omega'), 0o755)
} catch {
  /* ignore */
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.1.0'
writeFileSync(join(outRoot, 'VERSION'), version + '\n', 'utf8')
writeFileSync(join(outRoot, 'runtime', 'VERSION'), version + '\n', 'utf8')

console.log('[package-native-linux] OK:', outRoot)
