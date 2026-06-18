#!/usr/bin/env node
/**
 * Collect every npm path node-llama-cpp needs at runtime (hoisted + arbitrarily nested).
 *
 * Three strategies merged (no more one-missing-dep-per-reinstall):
 *  1. package.json graph from node-llama-cpp + lifecycle-utils
 *  2. Node resolver (createRequire) over all reachable .js/.mjs/.cjs
 *  3. npm ls --all --parseable for the same roots
 *
 * Output is staged under apps/desktop/.llama-pack-staging/node_modules with
 * exact paths preserved (ora/node_modules/string-width, etc.).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pruneNodeLlamaPrebuilds } from './lib/prune-installer-payload.mjs'
import { applyNodeLlamaCppGgufNativeFix } from './patch-node-llama-cpp-gguf.mjs'

const require = createRequire(import.meta.url)
const { packCpSync } = require('./lib/fs-copy-pack.cjs')

const scriptsDir = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(scriptsDir, '..')
export const STAGING_REL = 'apps/desktop/.llama-pack-staging/node_modules'
export const STAGING_DIR = join(REPO_ROOT, STAGING_REL)

const LLAMA_PKG = join('node_modules', 'node-llama-cpp')
const NESTED_ROOT = join(LLAMA_PKG, 'node_modules')

const IMPORT_RE =
  /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]*\s+from\s+)['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Listed in native packaging file lists — omit from staging (still traverse). */
export const SKIP_BUNDLE_ENTRIES = new Set([
  'node-llama-cpp',
  'better-sqlite3',
  'bindings',
  'file-uri-to-path'
])

/** Extra roots that ship beside node-llama-cpp in the installer. */
const RUNTIME_ROOTS = ['node-llama-cpp', 'lifecycle-utils']

/** @param {string} spec */
function bareImportPackage(spec) {
  if (!spec || !/^[@a-zA-Z0-9][@a-zA-Z0-9._/-]*$/.test(spec)) return null
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return spec.split('/')[0] || null
}

/**
 * @param {string} sourceRel
 */
export function isRootHoistedRel(sourceRel) {
  return /^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)$/.test(sourceRel)
}

/**
 * @param {string} root
 * @param {string} parentDir
 * @param {string} name
 * @returns {string | null}
 */
export function resolveDepDir(root, parentDir, name) {
  const segments = name.split('/')
  const local = join(parentDir, 'node_modules', ...segments)
  if (existsSync(join(local, 'package.json'))) return local

  const hoisted = join(root, 'node_modules', ...segments)
  if (existsSync(join(hoisted, 'package.json'))) return hoisted

  const llamaNested = join(root, NESTED_ROOT, ...segments)
  if (existsSync(join(llamaNested, 'package.json'))) return llamaNested

  return null
}

/**
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
export function resolvePackageDir(root, name) {
  return resolveDepDir(root, join(root, 'node_modules'), name)
}

/**
 * @param {string} resolvedFile
 * @param {string} root
 * @returns {string | null} sourceRel under node_modules/
 */
function packageRootFromResolved(resolvedFile, root) {
  let d = dirname(resolvedFile)
  const stop = join(root, 'node_modules')
  while (d.length >= stop.length) {
    if (existsSync(join(d, 'package.json'))) {
      const rel = relative(root, d).replace(/\\/g, '/')
      if (rel.startsWith('node_modules/')) return rel
      return null
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

/**
 * @param {string} nodeModulesDir
 * @returns {{ name: string, dir: string }[]}
 */
function listNestedPackages(nodeModulesDir) {
  /** @type {{ name: string, dir: string }[]} */
  const out = []
  if (!existsSync(nodeModulesDir)) return out
  for (const ent of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === '.bin') continue
    if (ent.name.startsWith('@')) {
      const scopePath = join(nodeModulesDir, ent.name)
      for (const pkg of readdirSync(scopePath, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        const dir = join(scopePath, pkg.name)
        if (existsSync(join(dir, 'package.json'))) {
          out.push({ name: `${ent.name}/${pkg.name}`, dir })
        }
      }
    } else {
      const dir = join(nodeModulesDir, ent.name)
      if (existsSync(join(dir, 'package.json'))) out.push({ name: ent.name, dir })
    }
  }
  return out
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walkJsFiles(dir) {
  /** @type {string[]} */
  const files = []
  if (!existsSync(dir)) return files
  /** @param {string} d */
  function walk(d) {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue
        walk(p)
      } else if (/\.(?:mjs|cjs|js)$/.test(ent.name)) {
        try {
          if (statSync(p).size < 8_000_000) files.push(p)
        } catch {
          /* skip */
        }
      }
    }
  }
  walk(dir)
  return files
}

/**
 * @param {string} root
 * @param {Set<string>} seen sourceRel
 */
function collectFromPackageGraph(root, seen) {
  /** @param {string} pkgDir */
  function visit(pkgDir) {
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return

    const sourceRel = relative(root, pkgDir).replace(/\\/g, '/')
    if (!sourceRel.startsWith('node_modules/')) return
    if (seen.has(sourceRel)) return
    seen.add(sourceRel)

    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    for (const block of [
      pkg.dependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies
    ]) {
      if (!block) continue
      for (const dep of Object.keys(block)) {
        const dir = resolveDepDir(root, pkgDir, dep)
        if (dir) visit(dir)
      }
    }

    for (const { dir } of listNestedPackages(join(pkgDir, 'node_modules'))) {
      visit(dir)
    }
  }

  for (const name of RUNTIME_ROOTS) {
    const dir = join(root, 'node_modules', name)
    if (existsSync(join(dir, 'package.json'))) visit(dir)
  }
}

/**
 * @param {string} root
 * @param {Set<string>} seen
 */
function collectFromRuntimeImports(root, seen) {
  /** @type {string[]} */
  const scanDirs = []
  for (const rel of [...seen]) {
    const pkgDir = join(root, rel)
    for (const sub of ['dist', 'lib', 'src', '.']) {
      const d = sub === '.' ? pkgDir : join(pkgDir, sub)
      if (existsSync(d)) scanDirs.push(d)
    }
  }

  const seeds = RUNTIME_ROOTS.map((n) => join(root, 'node_modules', n))
  for (const s of seeds) {
    scanDirs.push(join(s, 'dist'), s)
  }

  const visitedFiles = new Set()
  const queue = [...new Set(scanDirs)]

  while (queue.length) {
    const dir = queue.shift()
    for (const file of walkJsFiles(dir)) {
      if (visitedFiles.has(file)) continue
      visitedFiles.add(file)

      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }

      const req = createRequire(file)
      IMPORT_RE.lastIndex = 0
      let m
      while ((m = IMPORT_RE.exec(text))) {
        const spec = (m[1] || m[2] || '').trim()
        if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('#')) {
          continue
        }
        try {
          const resolved = req.resolve(spec)
          const sourceRel = packageRootFromResolved(resolved, root)
          if (!sourceRel || seen.has(sourceRel)) continue
          seen.add(sourceRel)
          const pkgDir = join(root, sourceRel)
          for (const sub of ['dist', 'lib', 'src']) {
            const d = join(pkgDir, sub)
            if (existsSync(d)) queue.push(d)
          }
        } catch {
          /* optional / uninstalled peer */
        }
      }
    }
  }
}

/**
 * @param {string} root
 * @param {Set<string>} seen
 */
function collectFromNpmLs(root, seen) {
  for (const pkgName of RUNTIME_ROOTS) {
    const r = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ls', pkgName, '--all', '--parseable', '--omit=dev'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
    if (r.status !== 0) continue
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const p = line.trim()
      if (!p) continue
      const rel = relative(root, p).replace(/\\/g, '/')
      if (rel.startsWith('node_modules/')) seen.add(rel)
    }
  }
}

/**
 * @param {string} root
 * @returns {Set<string>} sourceRel paths
 */
export function collectAllPackSourceRels(root = REPO_ROOT) {
  const seen = new Set()
  collectFromPackageGraph(root, seen)
  collectFromNpmLs(root, seen)
  // Fixed-point: imports may reference packages not listed in package.json
  for (let i = 0; i < 8; i++) {
    const before = seen.size
    collectFromRuntimeImports(root, seen)
    collectFromPackageGraph(root, seen)
    if (seen.size === before) break
  }
  return seen
}

/**
 * @param {string} root
 * @returns {{ name: string, sourceRel: string, hoisted: boolean }[]}
 */
export function collectNodeLlamaPackDepsDetailed(root = REPO_ROOT) {
  const seen = collectAllPackSourceRels(root)
  /** @type {{ name: string, sourceRel: string, hoisted: boolean }[]} */
  const out = []

  for (const sourceRel of [...seen].sort()) {
    if (sourceRel === LLAMA_PKG) continue
    const pkgJson = join(root, sourceRel, 'package.json')
    if (!existsSync(pkgJson)) continue
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
    const pkgName = String(pkg.name ?? '')
    if (SKIP_BUNDLE_ENTRIES.has(pkgName)) continue
    out.push({
      name: pkgName,
      sourceRel,
      hoisted: isRootHoistedRel(sourceRel)
    })
  }

  return out
}

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectNodeLlamaPackDeps(root = REPO_ROOT) {
  return collectNodeLlamaPackDepsDetailed(root).map((e) => e.name)
}

/** Strip leading node_modules/ for paths inside the staging folder. */
export function packDestRel(sourceRel) {
  return sourceRel.replace(/^node_modules[/\\]/, '').replace(/\\/g, '/')
}

/**
 * Copy every collected package into apps/desktop/.llama-pack-staging/node_modules
 * preserving nested paths exactly.
 *
 * @param {string} [root]
 * @returns {{ entries: ReturnType<typeof collectNodeLlamaPackDepsDetailed>, staged: number }}
 */
export function stageLlamaPackBundle(root = REPO_ROOT) {
  applyNodeLlamaCppGgufNativeFix(root)
  const entries = collectNodeLlamaPackDepsDetailed(root)
  rmSync(STAGING_DIR, { recursive: true, force: true })
  mkdirSync(STAGING_DIR, { recursive: true })

  let staged = 0
  for (const { sourceRel } of entries) {
    const src = join(root, sourceRel)
    const dest = join(STAGING_DIR, packDestRel(sourceRel))
    if (!existsSync(join(src, 'package.json'))) {
      throw new Error(`[packaging] missing source for staging: ${sourceRel}`)
    }
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true, dereference: true })
    staged++
  }

  // Node resolves bare imports from asar paths via hoisted node_modules/<pkg> first.
  // Duplicate nested-only packages (e.g. slice-ansi under node-llama-cpp/) at staging root.
  const atRoot = new Set(
    entries.filter((e) => isRootHoistedRel(e.sourceRel)).map((e) => e.name)
  )
  let shims = 0
  for (const e of entries) {
    if (atRoot.has(e.name)) continue
    const shimRel = `node_modules/${e.name}`
    const shimDest = join(STAGING_DIR, ...e.name.split('/'))
    if (existsSync(join(shimDest, 'package.json'))) {
      atRoot.add(e.name)
      continue
    }
    const src = join(root, e.sourceRel)
    mkdirSync(dirname(shimDest), { recursive: true })
    cpSync(src, shimDest, { recursive: true, dereference: true })
    entries.push({ name: e.name, sourceRel: shimRel, hoisted: true })
    atRoot.add(e.name)
    shims++
  }
  if (shims > 0) {
    console.log(`[packaging] added ${shims} root-level shims for nested-only packages`)
  }

  const chalkNested = join(STAGING_DIR, 'node-llama-cpp', 'node_modules', 'chalk')
  if (!existsSync(join(chalkNested, 'package.json'))) {
    const chalkSrc =
      resolvePackageDir(root, 'chalk') ??
      join(root, 'node_modules', 'node-llama-cpp', 'node_modules', 'chalk')
    if (existsSync(join(chalkSrc, 'package.json'))) {
      mkdirSync(dirname(chalkNested), { recursive: true })
      cpSync(chalkSrc, chalkNested, { recursive: true, dereference: true })
      console.log('[packaging] copied chalk → node-llama-cpp/node_modules/chalk')
    }
  }

  // SKIP_BUNDLE_ENTRIES omits these from the dep graph copy — always stage full trees
  // (dist/index.js, bindings, etc.) so after-pack and llama-js resources are complete.
  for (const name of RUNTIME_ROOTS) {
    const src = join(root, 'node_modules', name)
    if (!existsSync(join(src, 'package.json'))) {
      throw new Error(`[packaging] missing runtime package: ${name}`)
    }
    const dest = join(STAGING_DIR, name)
    rmSync(dest, { recursive: true, force: true })
    packCpSync(src, dest)
  }
  const llamaEntry = join(STAGING_DIR, 'node-llama-cpp', 'dist', 'index.js')
  if (!existsSync(llamaEntry)) {
    throw new Error(`[packaging] node-llama-cpp entry missing after staging: ${llamaEntry}`)
  }
  console.log('[packaging] staged full node-llama-cpp + lifecycle-utils (dist/index.js ok)')

  const pruned = pruneNodeLlamaPrebuilds(STAGING_DIR, root)
  if (pruned.removed.length) {
    console.log(
      `[packaging] pruned @node-llama-cpp prebuilds: ${pruned.removed.join(', ')} (~${pruned.freedMb} MB)`
    )
    console.log(`[packaging] kept: ${pruned.allowed.join(', ')}`)
  }

  entries.sort((a, b) => a.sourceRel.localeCompare(b.sourceRel))
  return { entries, staged: staged + shims }
}

/**
 * Verify Node can resolve every bare import in node-llama-cpp + lifecycle-utils
 * under a node_modules tree (staging dir or app.asar.unpacked).
 *
 * @param {string} [root] repo root (for error messages)
 * @param {string} [modulesDir] directory containing node-llama-cpp/ and lifecycle-utils/
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function verifyStagedLlamaImports(root = REPO_ROOT, modulesDir = STAGING_DIR) {
  if (!existsSync(modulesDir)) {
    return { ok: false, missing: [`node_modules tree missing: ${modulesDir}`] }
  }

  const missing = new Set()
  const scanRoots = RUNTIME_ROOTS.map((n) => join(modulesDir, n)).filter((d) => existsSync(d))

  for (const dir of scanRoots) {
    for (const file of walkJsFiles(join(dir, 'dist'))) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const req = createRequire(file)
      IMPORT_RE.lastIndex = 0
      let m
      while ((m = IMPORT_RE.exec(text))) {
        const spec = (m[1] || m[2] || '').trim()
        if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('#')) {
          continue
        }
        const pkg = bareImportPackage(spec)
        if (!pkg) continue
        try {
          req.resolve(pkg)
        } catch {
          missing.add(`${pkg} (from ${relative(root, file)})`)
        }
      }
    }
  }

  return { ok: missing.size === 0, missing: [...missing].sort() }
}
