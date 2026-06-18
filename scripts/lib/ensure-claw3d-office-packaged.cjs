/**
 * Verify claw3d-office standalone trace is present in installer resources.
 * electron-builder often omits node_modules under extraResources — repair after pack.
 */
const fs = require('fs')
const path = require('path')
const { packCpSync } = require('./fs-copy-pack.cjs')
const { standaloneAppDir } = require('./claw3d-paths.cjs')
const { copyServerRuntimeDeps, serverRuntimeDepsReady } = require('./claw3d-server-deps.cjs')
const {
  missingCriticalNextRoot,
  officeNextRootReady,
  syncOfficeNextRootManifests
} = require('./office-next-pack.cjs')

function claw3dPackChecks(destOffice) {
  const standalone = standaloneAppDir(destOffice)
  return {
    standalone,
    needStandaloneNext: path.join(standalone, 'node_modules', 'next', 'package.json'),
    needStandaloneWs: path.join(standalone, 'node_modules', 'ws', 'package.json'),
    needServer: path.join(destOffice, 'server', 'index.js'),
    needBuild: path.join(destOffice, '.next', 'BUILD_ID'),
    needRoutesManifest: path.join(destOffice, '.next', 'routes-manifest.json')
  }
}

function allPresent(checks, destOffice) {
  return (
    fs.existsSync(checks.needStandaloneNext) &&
    fs.existsSync(checks.needStandaloneWs) &&
    fs.existsSync(checks.needServer) &&
    fs.existsSync(checks.needBuild) &&
    fs.existsSync(checks.needRoutesManifest) &&
    officeNextRootReady(destOffice) &&
    serverRuntimeDepsReady(destOffice)
  )
}

/**
 * @param {string} appOutDir win-unpacked directory
 * @param {string} repoRoot Omega repo root
 */
function ensureClaw3dOfficePackaged(appOutDir, repoRoot) {
  const destOffice = path.join(appOutDir, 'resources', 'claw3d-office')
  let checks = claw3dPackChecks(destOffice)

  if (allPresent(checks, destOffice)) {
    return { ok: true, copied: false }
  }

  const srcOffice = path.join(repoRoot, 'apps', 'desktop', 'claw3d-office')
  if (!fs.existsSync(path.join(srcOffice, '.next', 'BUILD_ID'))) {
    throw new Error(
      'claw3d-office is not built. Run: node scripts/ensure-claw3d-office.mjs (or full build.bat)'
    )
  }
  const srcStandalone = standaloneAppDir(srcOffice)
  const srcNext = path.join(srcStandalone, 'node_modules', 'next', 'package.json')
  if (!fs.existsSync(srcNext)) {
    throw new Error(
      'claw3d-office standalone trace missing. Re-run: node scripts/ensure-claw3d-office.mjs'
    )
  }

  let copied = false

  const missingNext = missingCriticalNextRoot(destOffice)
  if (missingNext.length > 0) {
    const n = syncOfficeNextRootManifests(srcOffice, destOffice)
    copied = true
    console.log(
      `ensure-claw3d-office-packaged: synced .next root manifests (${n} files; was missing: ${missingNext.join(', ')})`
    )
  }

  if (!fs.existsSync(checks.needServer)) {
    const destServerDir = path.join(destOffice, 'server')
    fs.mkdirSync(destServerDir, { recursive: true })
    packCpSync(path.join(srcOffice, 'server'), destServerDir)
    copied = true
  }

  if (!fs.existsSync(checks.needStandaloneNext)) {
    const destStandalone = checks.standalone
    const srcNm = path.join(srcStandalone, 'node_modules')
    const destNm = path.join(destStandalone, 'node_modules')
    fs.mkdirSync(destStandalone, { recursive: true })
    packCpSync(srcNm, destNm)
    copied = true
    console.log(
      'ensure-claw3d-office-packaged: copied standalone node_modules (electron-builder omitted them)'
    )
  }

  if (!serverRuntimeDepsReady(destOffice)) {
    try {
      copyServerRuntimeDeps(srcOffice, repoRoot)
      copied = true
      console.log('ensure-claw3d-office-packaged: copied server runtime deps (ws, selfsigned, …)')
    } catch (e) {
      console.warn(
        `ensure-claw3d-office-packaged: server deps copy failed: ${e instanceof Error ? e.message : e}`
      )
    }
  }

  checks = claw3dPackChecks(destOffice)
  if (!allPresent(checks, destOffice)) {
    const missing = []
    if (!fs.existsSync(checks.needBuild)) missing.push('.next/BUILD_ID')
    if (!fs.existsSync(checks.needRoutesManifest)) missing.push('.next/routes-manifest.json')
    for (const f of missingCriticalNextRoot(destOffice)) {
      if (!missing.includes(`.next/${f}`)) missing.push(`.next/${f}`)
    }
    if (!fs.existsSync(checks.needServer)) missing.push('server/index.js')
    if (!fs.existsSync(checks.needStandaloneNext)) {
      missing.push('.next/standalone/node_modules/next')
    }
    if (!fs.existsSync(checks.needStandaloneWs)) {
      missing.push('.next/standalone/node_modules/ws')
    }
    const { webpackLibReady } = require('./claw3d-server-deps.cjs')
    if (!webpackLibReady(path.join(checks.standalone, 'node_modules'))) {
      missing.push('next/dist/compiled/webpack/webpack-lib')
    }
    throw new Error(
      `claw3d-office incomplete in installer resources (missing: ${missing.join(', ')}). Re-run build:win`
    )
  }

  return { ok: true, copied }
}

module.exports = { ensureClaw3dOfficePackaged, claw3dPackChecks }
