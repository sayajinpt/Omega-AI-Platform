#!/usr/bin/env node
/**
 * Phase 10 audit — renderer boundaries for thin UI architecture.
 * Run: node scripts/audit-renderer-boundaries.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(root, 'apps/desktop/src/renderer')

const mainImportForbidden = [
  /from\s+['"][^'"]*\/main\//,
  /from\s+['"][^'"]*apps\/desktop\/src\/main/,
  /require\s*\(\s*['"][^'"]*\/main\//
]

/** Only client.ts may touch window.omega (preload bridge). */
const omegaAllowlist = new Set([
  join(rendererDir, 'src/lib/engine/client.ts').replace(/\\/g, '/')
])

const violations = []

function scanFile(file) {
  const rel = relative(root, file).replace(/\\/g, '/')
  const src = readFileSync(file, 'utf8')

  for (const re of mainImportForbidden) {
    if (re.test(src)) violations.push({ file: rel, rule: 'main-import', detail: re.source })
  }

  if (/window\.omega/.test(src) && !omegaAllowlist.has(join(root, rel).replace(/\\/g, '/'))) {
    violations.push({
      file: rel,
      rule: 'window.omega',
      detail: 'Use engineClient from renderer/src/lib/engine instead'
    })
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(tsx?|jsx?)$/.test(name)) scanFile(p)
  }
}

walk(rendererDir)

console.log('Omega renderer boundary audit (Phase 10)')
console.log('=========================================')
if (violations.length === 0) {
  console.log('OK — no main/* imports; no window.omega outside lib/engine/client.ts')
  process.exit(0)
}
console.log(`FAIL — ${violations.length} violation(s):`)
for (const v of violations) console.log(`  [${v.rule}] ${v.file}`)
process.exit(1)
