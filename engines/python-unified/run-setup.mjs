#!/usr/bin/env node
/**
 * Create ~/.omega/venvs/unified — single Python environment for Omega.
 *
 *   node engines/python-unified/run-setup.mjs
 *   node engines/python-unified/run-setup.mjs --profile full
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const rootDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(rootDir, '..', '..')
const omegaHome = process.env.OMEGA_HOME ?? join(homedir(), '.omega')
const venvDir = join(omegaHome, 'venvs', 'unified')

function progress(phase, detail) {
  console.log(`OMEGA_PYTHON_UNIFIED_PROGRESS:${phase}|${detail}`)
}

function parseProfile(argv) {
  const flag = argv.find((a) => a.startsWith('--profile='))?.split('=')[1]
  const next = argv[argv.indexOf('--profile') + 1]
  return (flag ?? (argv.includes('--profile') ? next : 'base') ?? 'base').trim().toLowerCase()
}

function pyCmd() {
  const candidates =
    process.platform === 'win32'
      ? ['py -3.13', 'py -3.12', 'py -3.11', 'py -3.10', 'python', 'python3']
      : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  for (const c of candidates) {
    const [bin, ...args] = c.split(' ')
    const r = spawnSync(bin, [...args, '--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
    if (r.status === 0) return c
  }
  return null
}

function runShell(cmd, args, cwd, label) {
  console.log(`[python-unified] ${label}…`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`[python-unified] failed: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

function venvPython() {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python3')
}

function pipInstall(py, reqPath, label, opts = {}) {
  const args = ['-m', 'pip', 'install', '-r', reqPath]
  if (opts.noCache) args.push('--no-cache-dir')
  runShell(py, args, rootDir, label)
}

const profile = parseProfile(process.argv.slice(2))
const pyLauncher = pyCmd()
if (!pyLauncher) {
  console.error('[python-unified] Python 3.10+ not found. Install from https://python.org')
  process.exit(1)
}

progress('start', `profile=${profile}`)
mkdirSync(join(omegaHome, 'venvs'), { recursive: true })

if (!existsSync(venvPython())) {
  progress('venv', 'creating')
  const [bin, ...args] = pyLauncher.split(' ')
  runShell(bin, [...args, '-m', 'venv', venvDir], rootDir, 'create venv')
}

const py = venvPython()
runShell(py, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools'], rootDir, 'upgrade pip')

pipInstall(py, join(rootDir, 'requirements-unified.txt'), 'base requirements')

if (profile === 'sidecar' || profile === 'full') {
  pipInstall(py, join(repoRoot, 'engines', 'sidecar', 'requirements.txt'), 'sidecar stack')
}

const contentOmega = join(repoRoot, 'apps', 'desktop', 'content-studio', 'backend', 'requirements-omega.txt')
const contentMedia = join(repoRoot, 'apps', 'desktop', 'content-studio', 'backend', 'requirements-local-media.txt')

if (profile === 'content' || profile === 'full') {
  if (existsSync(contentOmega)) {
    pipInstall(py, contentOmega, 'content studio API')
    runShell(
      py,
      ['-m', 'pip', 'install', '-e', join(repoRoot, 'apps', 'desktop', 'content-studio', 'generation_models')],
      join(repoRoot, 'apps', 'desktop', 'content-studio'),
      'generation_models editable'
    )
  }
}

if (profile === 'full' && existsSync(contentMedia)) {
  pipInstall(py, contentMedia, 'content studio local media (torch/diffusers)', { noCache: true })
}

writeFileSync(
  join(venvDir, '.omega-profile'),
  JSON.stringify({ profile, installed_at: new Date().toISOString() }, null, 2)
)

progress('done', venvDir)
console.log(`[python-unified] OK: ${venvDir}`)
