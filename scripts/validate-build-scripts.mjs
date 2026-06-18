#!/usr/bin/env node
/**
 * Validate build scripts parse on any Windows dev machine (PowerShell 5.1+).
 * Catches issues like Write-Host "[tag]" in double quotes (breaks PS parser).
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptsDir = join(root, 'scripts')

/** @param {string} dir */
function collectPs1(dir) {
  /** @type {string[]} */
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...collectPs1(p))
    else if (ent.name.endsWith('.ps1')) out.push(p)
  }
  return out
}

/** @param {string} file */
function checkBracketHeuristic(file) {
  const text = readFileSync(file, 'utf8')
  const bad = /Write-(Host|Warning|Error)\s+"\[[A-Za-z][^\]$"]*\]/g
  const m = bad.exec(text)
  if (m) {
    throw new Error(
      `${file}: use single quotes for log tags like [build-engine] — found: ${m[0]}`
    )
  }
}

/** @param {string} file */
function parsePs1(file) {
  if (process.platform !== 'win32') return
  const escaped = file.replace(/'/g, "''")
  const cmd = `
$e = $null; $t = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$t, [ref]$e)
if ($e -and $e.Count -gt 0) {
  $e | ForEach-Object { Write-Error $_.ToString() }
  exit 1
}
`
  execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"').replace(/\r?\n/g, '; ')}"`, {
    stdio: 'inherit'
  })
}

const files = collectPs1(scriptsDir)
let failed = false
for (const file of files) {
  try {
    checkBracketHeuristic(file)
    parsePs1(file)
    console.log('[validate-build-scripts] OK', file.replace(root + '\\', '').replace(root + '/', ''))
  } catch (err) {
    failed = true
    console.error('[validate-build-scripts] FAIL', file, err instanceof Error ? err.message : err)
  }
}

if (failed) process.exit(1)
console.log(`[validate-build-scripts] ${files.length} PowerShell script(s) validated`)
