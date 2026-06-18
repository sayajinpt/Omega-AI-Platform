/**
 * Resolve powershell.exe / pwsh.exe when PATH is trimmed (npm, IDE terminals, etc.).
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** @returns {string | null} */
export function resolvePowerShellPath() {
  const fromEnv = process.env.OMEGA_POWERSHELL?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  if (process.platform !== 'win32') return null

  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'PowerShell', '7', 'pwsh.exe')
  ].filter(Boolean)

  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  for (const cmd of ['where powershell', 'where pwsh']) {
    try {
      const out = execSync(cmd, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      const first = out.split(/\r?\n/).find(Boolean)?.trim()
      if (first && existsSync(first)) return first
    } catch {
      /* not on PATH */
    }
  }

  return null
}

/**
 * @param {string} scriptPath
 * @param {string[]} [extraArgs]
 * @param {import('node:child_process').ExecSyncOptionsWithStringEncoding} [options]
 */
export function execPowerShellScript(scriptPath, extraArgs = [], options = {}) {
  const ps = resolvePowerShellPath()
  if (!ps) {
    throw new Error(
      'PowerShell not found (checked SystemRoot, Program Files, PATH). ' +
        'Install Windows PowerShell or set OMEGA_POWERSHELL to powershell.exe / pwsh.exe'
    )
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs]
  const quoted = `"${ps}" ${args.map((a) => `"${a}"`).join(' ')}`
  execSync(quoted, { shell: true, ...options })
}
