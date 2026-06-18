#!/usr/bin/env node
/**
 * Build a compressed .dmg from dist/native/Omega.app (macOS only).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = join(root, 'dist', 'native', 'Omega.app')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.1.0'
const dmgPath = join(root, 'dist', 'native', `Omega-${version}.dmg`)

if (process.platform !== 'darwin') {
  console.error('[package-dmg] run on macOS only (uses hdiutil)')
  process.exit(1)
}

if (!existsSync(appPath)) {
  console.error('[package-dmg] missing dist/native/Omega.app — run: npm run build:mac')
  process.exit(1)
}

if (existsSync(dmgPath)) rmSync(dmgPath, { force: true })

const run = spawnSync(
  'hdiutil',
  ['create', '-volname', 'Omega', '-srcfolder', appPath, '-ov', '-format', 'UDZO', dmgPath],
  { stdio: 'inherit' },
)

if (run.status !== 0) {
  console.error('[package-dmg] hdiutil failed')
  process.exit(run.status ?? 1)
}

console.log('[package-dmg] OK:', dmgPath)
