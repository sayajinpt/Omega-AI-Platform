#!/usr/bin/env node
/**
 * Optional EXL2 / ONNX GenAI venv installer (not bundled in base Omega installer size).
 *
 *   node engines/sidecar/run-setup.mjs --components exl2,onnx
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const sidecarDir = dirname(fileURLToPath(import.meta.url))
const omegaHome = process.env.OMEGA_HOME ?? join(homedir(), '.omega')
const venvDir = join(omegaHome, 'venvs', 'sidecar')

function progress(phase, detail) {
  console.log(`OMEGA_SIDECAR_PROGRESS:${phase}|${detail}`)
}

function parseComponents(argv) {
  const flag = argv.find((a) => a.startsWith('--components='))?.split('=')[1]
  const next = argv[argv.indexOf('--components') + 1]
  const raw = flag ?? (argv.includes('--components') ? next : 'exl2,onnx')
  const set = new Set(
    (raw ?? 'exl2,onnx')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
  return { exl2: set.has('exl2'), onnx: set.has('onnx') }
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
  console.log(`[setup:sidecar] ${label}…`)
  const r = spawnSync(cmd, args, { cwd: sidecarDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`[setup:sidecar] failed: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

/** Use `python -m pip` — direct pip.exe upgrade often fails on Windows (PEP 668 / self-upgrade). */
function runPip(python, pipArgs, label) {
  console.log(`[setup:sidecar] ${label}…`)
  const r = spawnSync(python, ['-m', 'pip', ...pipArgs], {
    cwd: sidecarDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) {
    console.error(`[setup:sidecar] pip failed: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

const want = parseComponents(process.argv.slice(2))
if (!want.exl2 && !want.onnx) {
  console.error('[setup:sidecar] Pass --components exl2,onnx (at least one)')
  process.exit(1)
}

const py = pyCmd()
if (!py) {
  console.error('[setup:sidecar] Python 3.10+ not found. Install from https://www.python.org/downloads/')
  process.exit(1)
}

progress('starting', `Components: ${[want.exl2 && 'EXL2', want.onnx && 'ONNX'].filter(Boolean).join(', ')}`)

mkdirSync(join(omegaHome, 'venvs'), { recursive: true })
const [pyBin, ...pyArgs] = py.split(' ')

if (!existsSync(join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin'))) {
  progress('venv', 'Creating Python virtual environment')
  run(pyBin, [...pyArgs, '-m', 'venv', venvDir], 'Creating venv')
}

const python =
  process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python3')

runPip(python, ['install', '--upgrade', 'pip'], 'Upgrading pip')
runPip(python, ['install', 'fastapi>=0.115.0', 'uvicorn[standard]>=0.32.0'], 'API server deps')

if (want.exl2) {
  progress('torch', 'Installing PyTorch (CUDA) for ExLlamaV2 — several minutes')
  runPip(
    python,
    [
      'install',
      'torch',
      '--index-url',
      'https://download.pytorch.org/whl/cu124',
      '--extra-index-url',
      'https://pypi.org/simple'
    ],
    'PyTorch'
  )
  progress('packages', 'Installing exllamav2')
  runPip(python, ['install', 'exllamav2>=0.3.2'], 'exllamav2')
}

if (want.onnx) {
  progress('packages', 'Installing onnxruntime-genai')
  runPip(python, ['install', 'onnxruntime-genai>=0.8.0'], 'onnxruntime-genai')
  runPip(python, ['install', 'transformers>=4.46.0', 'tokenizers>=0.20.0'], 'ONNX community tokenizer deps')
}

const checks = []
if (want.exl2) checks.push('import exllamav2')
if (want.onnx) checks.push('import onnxruntime_genai')
progress('verify', 'Verifying imports')
const check = spawnSync(python, ['-c', checks.join('; ') + '; print("ok")'], { encoding: 'utf8' })
if (check.status !== 0) {
  console.warn('[setup:sidecar] Warning: one or more selected backends failed import.')
  if (want.exl2) console.warn('  EXL2 needs NVIDIA GPU + CUDA PyTorch.')
} else {
  console.log('[setup:sidecar] Selected backends OK')
}

writeFileSync(
  join(omegaHome, 'sidecar-components.json'),
  JSON.stringify({ exl2: want.exl2, onnx: want.onnx, updatedAt: new Date().toISOString() }, null, 2)
)

progress('done', `venv ready at ${venvDir}`)
console.log(`[setup:sidecar] venv: ${venvDir}`)
