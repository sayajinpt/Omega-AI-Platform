#!/usr/bin/env node
/** Optional manual step: zip dist/native/Omega. Not run by build.bat — use NSIS installer instead. */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'dist', 'native', 'Omega')
const out = join(root, 'dist', 'native', 'Omega-native-win64.zip')

if (!existsSync(join(src, 'omega-desktop.exe'))) {
  console.error('[package-native-zip] missing dist/native/Omega — run: npm run build:shell')
  process.exit(1)
}

if (existsSync(out)) rmSync(out, { force: true })

execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${src.replace(/'/g, "''")}\\*' -DestinationPath '${out.replace(/'/g, "''")}' -Force`
  ],
  { stdio: 'inherit' }
)

console.log('[package-native-zip] OK:', out)
