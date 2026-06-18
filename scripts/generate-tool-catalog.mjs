#!/usr/bin/env node
/**
 * Maintain tool-catalog.json for omega-runtime.
 * Electron registry.ts was removed in Phase 8 — catalog is edited in place under apps/runtime/resources/.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = join(root, 'apps', 'desktop', 'src', 'main', 'tools', 'registry.ts')
const outPath = join(root, 'apps', 'runtime', 'resources', 'tool-catalog.json')

if (!existsSync(registryPath)) {
  if (!existsSync(outPath)) {
    console.error('[tool-catalog] missing registry.ts and', outPath)
    process.exit(1)
  }
  const existing = JSON.parse(readFileSync(outPath, 'utf8'))
  console.log(`[tool-catalog] using existing ${outPath} (${existing.count ?? existing.tools?.length ?? '?'} tools)`)
  process.exit(0)
}

const text = readFileSync(registryPath, 'utf8')
const start = text.indexOf('const builtins: ToolDef[] = [')
if (start < 0) throw new Error('builtins array not found in registry.ts')

const chunk = text.slice(start)
const tools = []
const blockRe = /\{\s*name:\s*'([^']+)'([\s\S]*?)run:/g
let m
while ((m = blockRe.exec(chunk)) !== null) {
  const name = m[1]
  const body = m[2]
  const descMatch = /description:\s*\n?\s*'((?:\\'|[^'])*)'/.exec(body) ||
    /description:\s*'((?:\\'|[^'])*)'/.exec(body)
  const description = descMatch?.[1]?.replace(/\\'/g, "'") ?? ''
  const enabled = /enabled:\s*(true|false)/.exec(body)?.[1] !== 'false'
  const source = /source:\s*'(builtin|plugin)'/.exec(body)?.[1] ?? 'builtin'
  const needsApproval = /needsApproval:\s*true/.test(body)
  tools.push({ name, description, enabled, source, needsApproval })
}

const catalog = {
  version: 1,
  generated_at: new Date().toISOString(),
  count: tools.length,
  tools
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(catalog, null, 2))
console.log(`[tool-catalog] ${outPath} (${tools.length} builtin tools)`)
