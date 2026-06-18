/**
 * Copy MSVC CRT DLLs next to packaged exes so omega-engine/runtime/desktop run on
 * clean Windows PCs without Visual Studio or a separate VC++ Redistributable install.
 *
 * Dev machines always have these in System32; end-user machines often do not — same
 * installer then works for the builder but fails for everyone else (Vulkan and CPU builds).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

/** CRT files used by /MD builds (VS 2015–2022 / VC142–VC143). */
export const VC_RUNTIME_DLLS = [
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'vcruntime140_threads.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'concrt140.dll',
  'vcomp140.dll'
]

/**
 * @returns {string | null} path to x64 Microsoft.VC*.CRT folder
 */
export function findVcCrtDir() {
  /** @type {string[]} */
  const roots = []

  if (process.env.VC_REDIST_CRT_DIR && existsSync(process.env.VC_REDIST_CRT_DIR)) {
    return process.env.VC_REDIST_CRT_DIR
  }

  try {
    const vswhere =
      '"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"'
    const inst = execSync(`${vswhere} -latest -products * -property installationPath`, {
      encoding: 'utf8'
    }).trim()
    if (inst) roots.push(join(inst, 'VC', 'Redist', 'MSVC'))
  } catch {
    /* vswhere optional */
  }

  for (const guess of [
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Redist\\MSVC',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Redist\\MSVC',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Redist\\MSVC',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\VC\\Redist\\MSVC'
  ]) {
    if (existsSync(guess)) roots.push(guess)
  }

  for (const msvcRoot of roots) {
    let versions = []
    try {
      versions = readdirSync(msvcRoot).filter((v) => /^\d+\.\d+/.test(v)).sort().reverse()
    } catch {
      continue
    }
    for (const ver of versions) {
      for (const crtName of ['Microsoft.VC143.CRT', 'Microsoft.VC142.CRT', 'Microsoft.VC141.CRT']) {
        const crt = join(msvcRoot, ver, 'x64', crtName)
        if (existsSync(crt)) return crt
      }
    }
  }

  return null
}

/**
 * @param {string[]} targetDirs absolute directories (created if missing)
 * @param {{ required?: boolean, label?: string }} opts
 */
export function stageVcRuntimeToDirs(targetDirs, opts = {}) {
  const { required = false, label = 'stage-vc-runtime' } = opts
  const crtDir = findVcCrtDir()

  if (!crtDir) {
    const msg =
      `${label}: MSVC CRT redist folder not found on build machine. ` +
      'Install Visual Studio C++ workload or set VC_REDIST_CRT_DIR. ' +
      'Without bundled CRT DLLs, the installer only works on PCs that already have VC++ Redistributable.'
    if (required) {
      console.error('[stage-vc-runtime] FATAL:', msg)
      process.exit(1)
    }
    console.warn('[stage-vc-runtime]', msg)
    return { crtDir: null, copied: [], skipped: VC_RUNTIME_DLLS, targets: targetDirs }
  }

  /** @type {string[]} */
  const copied = []
  /** @type {string[]} */
  const skipped = []

  for (const dll of VC_RUNTIME_DLLS) {
    const src = join(crtDir, dll)
    if (!existsSync(src)) {
      skipped.push(dll)
      continue
    }
    for (const dir of targetDirs) {
      if (!dir) continue
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, dll)
      copyFileSync(src, dest)
    }
    copied.push(dll)
  }

  console.log(
    `[stage-vc-runtime] ${label}: copied ${copied.length} CRT DLLs from ${crtDir} → ${targetDirs.length} folder(s)`
  )
  if (skipped.length) {
    console.warn('[stage-vc-runtime] optional DLLs not in redist:', skipped.join(', '))
  }

  return { crtDir, copied, skipped, targets: targetDirs }
}

/**
 * Write a small support manifest under the packaged app root.
 * @param {string} appRoot dist/native/Omega
 * @param {{ crtDir: string | null, copied: string[] }} vc
 */
export function writeInstallManifest(appRoot, vc) {
  const engineDir = join(appRoot, 'engine')
  const inferDll = join(engineDir, 'omega_infer.dll')
  let inferBytes = 0
  if (existsSync(inferDll)) {
    inferBytes = statSync(inferDll).size
  }

  const manifest = {
    packagedAt: new Date().toISOString(),
    vcCrtSource: vc.crtDir,
    vcCrtDlls: vc.copied,
    omegaInferDllBytes: inferBytes,
    note:
      'If model load fails on another PC, collect %USERPROFILE%\\.omega\\logs\\omega-load.log'
  }

  writeFileSync(join(appRoot, 'install-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
