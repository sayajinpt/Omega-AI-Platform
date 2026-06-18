#!/usr/bin/env node
/**
 * Dev/CI only: temporary backend/.venv for build validation.
 * Packaged Omega does NOT use this — runtime uses ~/.omega/venvs/unified (see engines/python-unified/README.md).
 * Native packaging strips backend/.venv before NSIS.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const omegaRoot = resolve(scriptsDir, '..')
const bundleRoot = join(omegaRoot, 'apps', 'desktop', 'content-studio')
const backend = join(bundleRoot, 'backend')
const venvDir = join(backend, '.venv')
const venvPy =
  process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
const marker = join(backend, 'app', 'main.py')

if (!existsSync(marker)) {
  console.error('[content-studio] Missing bundled backend at apps/desktop/content-studio/backend/')
  console.error('Content Studio must be included in the Omega repository — it is not fetched from outside this tree.')
  process.exit(1)
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts })
}

if (existsSync(venvDir)) {
  console.log('[content-studio] Removing existing .venv (fresh install for this build)…')
  rmSync(venvDir, { recursive: true, force: true })
}

const py = process.platform === 'win32' ? 'python' : 'python3'
console.log('[content-studio] Creating venv…')
run(`${py} -m venv "${venvDir}"`, { cwd: backend })

const req = existsSync(join(backend, 'requirements-omega.txt'))
  ? 'requirements-omega.txt'
  : 'requirements.txt'

console.log(`[content-studio] pip install ${req}…`)
run(`"${venvPy}" -m pip install -q --upgrade pip`, { cwd: backend })
run(`"${venvPy}" -m pip install -q -r ${req}`, { cwd: backend })

const localMedia = join(backend, 'requirements-local-media.txt')
if (existsSync(localMedia)) {
  console.log('[content-studio] pip install local media stack (optional, large)…')
  try {
    run(`"${venvPy}" -m pip install -q --no-cache-dir -r requirements-local-media.txt`, { cwd: backend })
  } catch {
    console.warn('[content-studio] Local media extras failed — script-only mode still works.')
  }
}

const bundleWheels = process.env.OMEGA_BUNDLE_PREBUILT_WHEELS === '1'
const prebuiltWheels = join(bundleRoot, 'prebuilt-wheels')
const gpuScript = join(backend, 'scripts', 'install_gpu_extras.py')
if (bundleWheels && existsSync(gpuScript) && process.platform !== 'darwin') {
  mkdirSync(prebuiltWheels, { recursive: true })
  console.log('[content-studio] Optional: caching FlashAttention wheel in prebuilt-wheels/ (dev offline)…')
  try {
    run(`"${venvPy}" "${gpuScript}" --bundle-wheels "${prebuiltWheels}"`, { cwd: backend })
  } catch {
    console.warn(
      '[content-studio] FlashAttention wheel cache skipped (packaged installs download on first GPU setup).'
    )
  }
} else if (process.platform !== 'darwin') {
  console.log(
    '[content-studio] prebuilt-wheels/ not bundled (set OMEGA_BUNDLE_PREBUILT_WHEELS=1 for dev offline cache).'
  )
} else {
  console.log('[content-studio] macOS: no CUDA flash-attn wheel (TTS uses PyTorch SDPA).')
}

const soxScript = join(backend, 'scripts', 'install_sox.py')
const soxBundleDir = join(bundleRoot, 'tools', 'sox')
if (process.platform === 'win32' && existsSync(soxScript)) {
  console.log('[content-studio] Bundling SoX for Windows installer…')
  try {
    run(`"${venvPy}" "${soxScript}" --bundle-to "${soxBundleDir}"`, { cwd: backend })
  } catch {
    console.warn(
      '[content-studio] SoX bundle failed — first Content Studio setup will download it (~2 MB).'
    )
  }
}

console.log('[content-studio] Ready at', bundleRoot)
console.log(
  '[content-studio] Note: .venv is stripped before pack; flash-attn wheel downloads on first Content Studio GPU setup.'
)
