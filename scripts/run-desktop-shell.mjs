#!/usr/bin/env node
/** Launch dist/shell/omega-desktop.exe (native WebView2 host). */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exe = join(root, 'dist', 'shell', 'omega-desktop.exe')

if (!existsSync(exe)) {
  console.error('[run-desktop-shell] missing', exe, '— run: npm run build:shell')
  process.exit(1)
}

const child = spawn(exe, [], { stdio: 'inherit', cwd: join(root, 'dist', 'shell') })
child.on('exit', (code) => process.exit(code ?? 0))
