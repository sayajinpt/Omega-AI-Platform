#!/usr/bin/env node
/**
 * Python venv for smart-input router model builds (Optimum + Transformers).
 *
 *   node engines/router-models/run-setup.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const engineDir = dirname(fileURLToPath(import.meta.url))
const omegaHome = process.env.OMEGA_HOME ?? join(homedir(), '.omega')
const venvDir = join(omegaHome, 'venvs', 'router-models')

function progress(phase, detail) {
  console.log(`OMEGA_ROUTER_SETUP_PROGRESS:${phase}|${detail}`)
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

function run(cmd, args, label) {
  console.log(`[setup:router-models] ${label}…`)
  const r = spawnSync(cmd, args, {
    cwd: engineDir,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    console.error(`[setup:router-models] failed: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

/** `python -m pip` — direct pip.exe upgrade often fails on Windows. */
function runPip(python, pipArgs, label) {
  console.log(`[setup:router-models] ${label}…`)
  const r = spawnSync(python, ['-m', 'pip', ...pipArgs], {
    cwd: engineDir,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    console.error(`[setup:router-models] pip failed: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

const py = pyCmd()
if (!py) {
  console.error('[setup:router-models] Python 3.10+ not found. Install from https://www.python.org/downloads/')
  process.exit(1)
}

progress('starting', 'Smart-input router Python environment')

mkdirSync(join(omegaHome, 'venvs'), { recursive: true })
const [pyBin, ...pyArgs] = py.split(' ')

const venvBin = process.platform === 'win32' ? join(venvDir, 'Scripts') : join(venvDir, 'bin')
if (!existsSync(venvBin)) {
  progress('venv', 'Creating virtual environment')
  run(pyBin, [...pyArgs, '-m', 'venv', venvDir], 'venv')
}

const python =
  process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python3')

runPip(python, ['install', '--upgrade', 'pip'], 'pip upgrade')
progress('packages', 'Installing transformers + optimum (may take several minutes)')
runPip(python, ['install', '-r', join(engineDir, 'requirements.txt')], 'requirements')

progress('verify', 'Verifying imports')
run(python, ['-c', 'import transformers, optimum.onnxruntime'], 'verify')

progress('done', `Venv ready at ${venvDir}`)
