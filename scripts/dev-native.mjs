#!/usr/bin/env node
/**
 * Native dev: watch-build React UI, sync to dist/shell/ui, launch omega-desktop.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, watch } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellExe = join(root, 'dist', 'shell', 'omega-desktop.exe')
const uiSrc = join(root, 'dist', 'ui')
const shellUi = join(root, 'dist', 'shell', 'ui')

function syncUiToShell() {
  if (!existsSync(uiSrc)) return false
  cpSync(uiSrc, shellUi, { recursive: true })
  for (const page of ['index.native.html', 'avatar-monitor.html', 'screen-snip.html']) {
    const src = join(shellUi, page)
    if (!existsSync(src)) continue
    const base = page === 'index.native.html' ? 'index.html' : page
    copyFileSync(src, join(shellUi, base))
  }
  console.log('[dev-native] synced dist/ui → dist/shell/ui')
  return true
}

function ensureShell() {
  if (existsSync(shellExe)) return true
  console.log('[dev-native] building shell (first run)…')
  const r = spawnSync('npm', ['run', 'build:shell'], { cwd: root, stdio: 'inherit', shell: true })
  return r.status === 0
}

function runUiWatch() {
  return spawn('npm', ['run', '-w', '@omega/desktop', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    shell: true
  })
}

function launchShell() {
  return spawn(shellExe, [], {
    cwd: join(root, 'dist', 'shell'),
    stdio: 'inherit'
  })
}

if (!ensureShell()) process.exit(1)

const ui = runUiWatch()
let shell = null
let syncTimer = null

const scheduleSync = () => {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    if (!syncUiToShell()) return
    if (!shell || shell.exitCode !== null) {
      shell = launchShell()
      shell.on('exit', () => {
        shell = null
      })
    }
  }, 400)
}

if (existsSync(uiSrc)) {
  scheduleSync()
} else {
  console.log('[dev-native] waiting for first UI build…')
}

try {
  watch(uiSrc, { recursive: true }, scheduleSync)
} catch {
  /* dist/ui may not exist until first vite output */
  const poll = setInterval(() => {
    if (existsSync(uiSrc)) {
      clearInterval(poll)
      watch(uiSrc, { recursive: true }, scheduleSync)
      scheduleSync()
    }
  }, 1000)
}

const shutdown = (code = 0) => {
  if (shell && shell.exitCode === null) shell.kill()
  if (ui.exitCode === null) ui.kill()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
ui.on('exit', (code) => shutdown(code ?? 0))
