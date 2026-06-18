/**
 * Resolve cmake.exe: PATH, OMEGA_CMAKE, Visual Studio bundled CMake (vswhere), common installs.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const VS_CMAKE_REL =
  'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe'

function vswherePath() {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  ].filter(Boolean)
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function vswhereFind(vw, pattern) {
  try {
    const out = execSync(`"${vw}" -latest -find "${pattern}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    const line = out.split(/\r?\n/).find((l) => l.trim())
    return line?.trim() || null
  } catch {
    return null
  }
}

function vsInstallPath(vw) {
  try {
    const out = execSync(`"${vw}" -latest -property installationPath`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/** @returns {string | null} absolute path to cmake.exe */
export function resolveCmakePath() {
  if (process.env.OMEGA_CMAKE?.trim() && existsSync(process.env.OMEGA_CMAKE.trim())) {
    return process.env.OMEGA_CMAKE.trim()
  }

  try {
    execSync('cmake --version', { stdio: 'ignore' })
    const cmd = process.platform === 'win32' ? 'where cmake' : 'which cmake'
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).find((l) => l.trim())
    if (first && existsSync(first.trim())) return first.trim()
  } catch {
    /* not on PATH */
  }

  if (process.platform === 'win32') {
    const vw = vswherePath()
    if (vw) {
      const found = vswhereFind(vw, VS_CMAKE_REL)
      if (found && existsSync(found)) return found
      const install = vsInstallPath(vw)
      if (install) {
        const bundled = join(install, ...VS_CMAKE_REL.split('\\'))
        if (existsSync(bundled)) return bundled
      }
    }

    for (const p of [
      'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe',
      'C:\\Program Files\\CMake\\bin\\cmake.exe'
    ]) {
      if (existsSync(p)) return p
    }
  }

  return null
}
