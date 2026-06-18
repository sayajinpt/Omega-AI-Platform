#!/usr/bin/env node
/**
 * Bundle Claw3D office (Next.js) for Omega installers.
 * Output: apps/desktop/claw3d-office (production build).
 *
 * Invoked automatically by build.bat → build:win → build-windows-native.ps1
 * and by npm prebuild:shell before package-native-shell.mjs.
 */
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { copyServerRuntimeDeps, serverRuntimeDepsReady } = require('./lib/claw3d-server-deps.cjs')
const { officeNextRootReady, syncOfficeNextRootManifests } = require('./lib/office-next-pack.cjs')

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const omegaRoot = resolve(scriptsDir, '..')
const bundleRoot = join(omegaRoot, 'apps', 'desktop', 'claw3d-office')
const marker = join(bundleRoot, '.next', 'BUILD_ID')
const nextPkg = join(bundleRoot, 'node_modules', 'next', 'package.json')
const wsPkg = join(bundleRoot, 'node_modules', 'ws', 'package.json')

/** Next standalone app dir (flat when outputFileTracingRoot is the app folder). */
function standaloneAppDir() {
  const flat = join(bundleRoot, '.next', 'standalone')
  const nested = join(flat, 'apps', 'desktop', 'claw3d-office')
  if (existsSync(join(nested, 'server.js'))) return nested
  return flat
}

function standaloneNextPkgPath() {
  return join(standaloneAppDir(), 'node_modules', 'next', 'package.json')
}

/** Default upstream: https://github.com/iamlukethedev/claw3d */
const CLAW3D_OFFICE_REPO =
  process.env.OMEGA_CLAW3D_OFFICE_REPO?.trim() || 'https://github.com/iamlukethedev/claw3d.git'

const SOURCE_EXT = /\.(ts|tsx|mjs|js|json)$/i
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'out'])

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts })
}

function maxMtimeInTree(rootDir) {
  if (!existsSync(rootDir)) return 0
  let max = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      max = Math.max(max, statSync(full).mtimeMs)
    }
  }
  walk(rootDir)
  return max
}

function isOfficeBuildStale() {
  if (process.env.OMEGA_FORCE_CLAW3D_OFFICE_BUILD === '1') return true
  if (!existsSync(marker)) return true
  const buildMtime = statSync(marker).mtimeMs
  const srcMtime = maxMtimeInTree(join(bundleRoot, 'src'))
  const configMtime = Math.max(
    existsSync(join(bundleRoot, 'package.json'))
      ? statSync(join(bundleRoot, 'package.json')).mtimeMs
      : 0,
    existsSync(join(bundleRoot, 'next.config.ts'))
      ? statSync(join(bundleRoot, 'next.config.ts')).mtimeMs
      : 0,
    existsSync(join(bundleRoot, 'next.config.mjs'))
      ? statSync(join(bundleRoot, 'next.config.mjs')).mtimeMs
      : 0,
  )
  return srcMtime > buildMtime || configMtime > buildMtime
}

function syncStandaloneAssets() {
  const standaloneDir = standaloneAppDir()
  if (!existsSync(join(standaloneDir, 'node_modules'))) return
  const staticSrc = join(bundleRoot, '.next', 'static')
  const staticDest = join(standaloneDir, '.next', 'static')
  if (existsSync(staticSrc)) {
    mkdirSync(join(standaloneDir, '.next'), { recursive: true })
    cpSync(staticSrc, staticDest, { recursive: true })
  }
  const publicSrc = join(bundleRoot, 'public')
  const publicDest = join(standaloneDir, 'public')
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, publicDest, { recursive: true })
  }
  console.log('[claw3d] standalone assets linked (.next/static + public)')
}

function syncServerRuntimeDeps() {
  if (!existsSync(standaloneNextPkgPath())) return
  if (serverRuntimeDepsReady(bundleRoot)) return
  copyServerRuntimeDeps(bundleRoot, omegaRoot)
  console.log('[claw3d] server runtime deps copied into standalone (ws, selfsigned, …)')
}

const standaloneNextPkg = standaloneNextPkgPath()
const depsReady = existsSync(standaloneNextPkg) || (existsSync(nextPkg) && existsSync(wsPkg))

if (!isOfficeBuildStale() && depsReady) {
  syncServerRuntimeDeps()
  if (serverRuntimeDepsReady(bundleRoot)) {
    console.log('[claw3d] Production build is up to date at', bundleRoot)
    process.exit(0)
  }
  console.log('[claw3d] standalone missing server deps — refreshing…')
}

if (existsSync(marker) && isOfficeBuildStale()) {
  console.log('[claw3d] Source changed since last .next build — rebuilding office…')
}

if (existsSync(marker) && !depsReady) {
  console.log('[claw3d] .next build present but node_modules incomplete — refreshing install…')
}

if (!existsSync(join(bundleRoot, 'package.json'))) {
  console.log('[claw3d] Cloning from', CLAW3D_OFFICE_REPO)
  run(`git clone --depth 1 ${CLAW3D_OFFICE_REPO} "${bundleRoot}"`, { cwd: omegaRoot })
}

// Full install (incl. devDeps): Next build needs @tailwindcss/postcss etc. Installer ships
// .next/standalone traced deps only — not this node_modules tree.
const lock = join(bundleRoot, 'package-lock.json')
console.log(lock && existsSync(lock) ? '[claw3d] npm ci…' : '[claw3d] npm install…')
run(lock && existsSync(lock) ? 'npm ci' : 'npm install', { cwd: bundleRoot })

console.log('[claw3d] npm run build (standalone)…')
run('npm run build', { cwd: bundleRoot, env: { ...process.env, NODE_ENV: 'production' } })
syncStandaloneAssets()
syncServerRuntimeDeps()
syncOfficeNextRootManifests(bundleRoot, bundleRoot)
if (!officeNextRootReady(bundleRoot)) {
  const { missingCriticalNextRoot } = require('./lib/office-next-pack.cjs')
  const miss = missingCriticalNextRoot(bundleRoot)
  console.error('[claw3d] build incomplete — missing .next:', miss.join(', '))
  process.exit(1)
}

if (!existsSync(marker)) {
  console.error('[claw3d] Build failed — .next/BUILD_ID missing')
  process.exit(1)
}

if (!existsSync(standaloneNextPkg)) {
  console.error('[claw3d] build incomplete — need .next/standalone/node_modules/next')
  process.exit(1)
}
const standaloneNm = join(standaloneAppDir(), 'node_modules')
if (!existsSync(join(standaloneNm, 'baseline-browser-mapping', 'package.json'))) {
  console.error('[claw3d] build incomplete — baseline-browser-mapping missing from standalone')
  process.exit(1)
}
if (!existsSync(join(standaloneNm, 'caniuse-lite', 'package.json'))) {
  console.error('[claw3d] build incomplete — caniuse-lite missing from standalone')
  process.exit(1)
}
if (!serverRuntimeDepsReady(bundleRoot)) {
  console.error('[claw3d] build incomplete — ws missing from standalone (server gateway)')
  process.exit(1)
}

console.log('[claw3d] Ready at', bundleRoot)
