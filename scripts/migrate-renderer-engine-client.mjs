#!/usr/bin/env node
/**
 * Phase 10 — replace window.omega with engineClient across renderer (idempotent).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(root, 'apps/desktop/src/renderer')
const engineDir = join(rendererDir, 'src/lib/engine')

const skip = new Set([
  join(rendererDir, 'src/lib/engine/client.ts'),
  join(rendererDir, 'src/lib/omega.d.ts')
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?)$/.test(name)) out.push(p)
  }
  return out
}

function engineImportPath(file) {
  let rel = relative(dirname(file), engineDir).replace(/\\/g, '/')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

function ensureEngineImport(src, file) {
  if (/import\s*\{[^}]*\bengineClient\b/.test(src)) return src
  const path = engineImportPath(file)
  const line = `import { engineClient } from '${path}'\n`
  const block = src.match(/^((?:import .+\n)+)/)
  if (block) return src.replace(block[0], block[0] + line)
  return line + src
}

let changed = 0

for (const file of walk(rendererDir)) {
  if (skip.has(file)) continue
  const before = readFileSync(file, 'utf8')
  if (!before.includes('window.omega')) continue

  let src = before.replace(/window\.omega/g, 'engineClient')
  src = ensureEngineImport(src, file)

  src = src.replace(
    /import\s*\{([^}]+)\}\s*from\s*(['"][^'"]*lib\/engine['"])/g,
    (m, inner, from) => {
      const names = inner.split(',').map((s) => s.trim()).filter(Boolean)
      if (names.includes('engineClient')) return m
      return `import { engineClient, ${names.join(', ')} } from ${from}`
    }
  )

  if (src !== before) {
    writeFileSync(file, src)
    changed++
    console.log(relative(root, file))
  }
}

console.log(`\nUpdated ${changed} file(s).`)
