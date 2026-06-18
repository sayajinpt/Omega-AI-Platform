/**
 * Custom office server (server/*.js) requires packages Next standalone does not trace.
 */
const fs = require('fs')
const path = require('path')
const { packCpSync } = require('./fs-copy-pack.cjs')
const { standaloneAppDir } = require('./claw3d-paths.cjs')

/** Required for gateway proxy + adapter (not traced by Next standalone). */
const OFFICE_SERVER_REQUIRED = ['ws']
/** Optional — HTTPS dev certs in server/index.js (devDependency in claw3d). */
const OFFICE_SERVER_OPTIONAL = ['selfsigned']
/**
 * Next loads next.config.ts at runtime; compiled browserslist pulls these in via require()
 * but they are not always included in the standalone file trace.
 */
const NEXT_CONFIG_RUNTIME_REQUIRED = ['baseline-browser-mapping', 'caniuse-lite']

/**
 * @param {string} pkgName
 * @param {string[]} roots directories that may contain node_modules/<pkg>
 * @returns {string | null}
 */
function resolvePkgDir(pkgName, roots) {
  for (const root of roots) {
    const dir = path.join(root, 'node_modules', pkgName)
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

/**
 * @param {string} pkgDir
 * @returns {string[]}
 */
function dependencyNames(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const names = []
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (pkg[field] && typeof pkg[field] === 'object') {
      names.push(...Object.keys(pkg[field]))
    }
  }
  return names
}

function joinNext(destNm) {
  return path.join(destNm, 'next', 'package.json')
}

function webpackLibReady(destNm) {
  const candidates = [
    path.join(destNm, 'next', 'dist', 'compiled', 'webpack', 'webpack-lib.js'),
    path.join(destNm, 'next', 'dist', 'compiled', 'webpack', 'webpack-lib'),
    path.join(destNm, 'next', 'dist', 'compiled', 'webpack', 'webpack-lib.cjs')
  ]
  return candidates.find((p) => fs.existsSync(p))
}

/** Copy Next internal compiled bundles (webpack-lib etc.) required by custom server in production. */
function copyNextCompiledInternals(officeRoot, omegaRoot) {
  const destNm = path.join(standaloneAppDir(officeRoot), 'node_modules')
  if (webpackLibReady(destNm)) return

  const srcRoots = [officeRoot, path.join(omegaRoot, 'apps', 'desktop'), omegaRoot]
  for (const root of srcRoots) {
    const compiled = path.join(root, 'node_modules', 'next', 'dist', 'compiled')
    if (!fs.existsSync(compiled)) continue
    const destCompiled = path.join(destNm, 'next', 'dist', 'compiled')
    fs.mkdirSync(path.dirname(destCompiled), { recursive: true })
    packCpSync(compiled, destCompiled)
    console.log('copyNextCompiledInternals: copied next/dist/compiled into standalone')
    return
  }
  console.warn('copyNextCompiledInternals: next/dist/compiled not found in build tree')
}

/**
 * Copy server-only packages into .next/standalone/node_modules for packaged office.
 * @param {string} officeRoot apps/desktop/claw3d-office
 * @param {string} omegaRoot Omega repo root
 */
function copyServerRuntimeDeps(officeRoot, omegaRoot) {
  const destNm = path.join(standaloneAppDir(officeRoot), 'node_modules')
  if (!fs.existsSync(joinNext(destNm))) {
    throw new Error(
      'claw3d standalone node_modules missing — run next build before copyServerRuntimeDeps'
    )
  }

  const srcRoots = [officeRoot, path.join(omegaRoot, 'apps', 'desktop'), omegaRoot]
  fs.mkdirSync(destNm, { recursive: true })

  const queue = [
    ...OFFICE_SERVER_REQUIRED,
    ...OFFICE_SERVER_OPTIONAL,
    ...NEXT_CONFIG_RUNTIME_REQUIRED
  ]
  const copied = new Set()
  const required = new Set([...OFFICE_SERVER_REQUIRED, ...NEXT_CONFIG_RUNTIME_REQUIRED])

  while (queue.length > 0) {
    const name = queue.shift()
    if (copied.has(name)) continue
    const src = resolvePkgDir(name, srcRoots)
    if (!src) {
      if (required.has(name)) {
        throw new Error(
          `claw3d server dependency "${name}" not found. Run npm install in apps/desktop/claw3d-office`
        )
      }
      continue
    }
    packCpSync(src, path.join(destNm, name))
    copied.add(name)
    for (const dep of dependencyNames(src)) {
      if (!copied.has(dep)) queue.push(dep)
    }
  }

  copyNextCompiledInternals(officeRoot, omegaRoot)
}

/**
 * @param {string} officeRoot
 * @returns {boolean}
 */
function serverRuntimeDepsReady(officeRoot) {
  const destNm = path.join(standaloneAppDir(officeRoot), 'node_modules')
  return (
    fs.existsSync(joinNext(destNm)) &&
    fs.existsSync(path.join(destNm, 'ws', 'package.json')) &&
    fs.existsSync(path.join(destNm, 'baseline-browser-mapping', 'package.json')) &&
    fs.existsSync(path.join(destNm, 'caniuse-lite', 'package.json')) &&
    Boolean(webpackLibReady(destNm))
  )
}

module.exports = {
  OFFICE_SERVER_REQUIRED,
  OFFICE_SERVER_OPTIONAL,
  NEXT_CONFIG_RUNTIME_REQUIRED,
  copyServerRuntimeDeps,
  copyNextCompiledInternals,
  serverRuntimeDepsReady,
  resolvePkgDir,
  webpackLibReady
}
