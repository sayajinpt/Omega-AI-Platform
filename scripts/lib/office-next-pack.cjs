/**
 * Next custom server (claw3d-office/server/index.js) reads manifests from <office>/.next/.
 * electron-builder copies BUILD_ID/server/static piecemeal — root manifests are often omitted.
 */
const fs = require('fs')
const path = require('path')
const { packCpSync } = require('./fs-copy-pack.cjs')
const { standaloneAppDir } = require('./claw3d-paths.cjs')

/** Must exist before office HTTP can serve pages (Next prepare + request handling). */
const CRITICAL_NEXT_ROOT = [
  'BUILD_ID',
  'routes-manifest.json',
  'prerender-manifest.json',
  'build-manifest.json'
]

/**
 * @param {string} officeRoot
 * @returns {string[]}
 */
function missingCriticalNextRoot(officeRoot) {
  const destNext = path.join(officeRoot, '.next')
  return CRITICAL_NEXT_ROOT.filter((name) => !fs.existsSync(path.join(destNext, name)))
}

/**
 * @param {string} officeRoot apps/desktop/claw3d-office
 */
function officeNextRootReady(officeRoot) {
  const destNext = path.join(officeRoot, '.next')
  if (missingCriticalNextRoot(officeRoot).length > 0) return false
  return fs.existsSync(path.join(destNext, 'server', 'pages-manifest.json'))
}

/**
 * Copy every file in .next/ root (BUILD_ID + *.json) from build tree into dest.
 * @param {string} srcOffice built claw3d-office in repo
 * @param {string} destOffice packaged resources/claw3d-office
 * @returns {number} files copied
 */
function syncOfficeNextRootManifests(srcOffice, destOffice) {
  const srcNext = path.join(srcOffice, '.next')
  const standaloneNext = path.join(standaloneAppDir(srcOffice), '.next')
  const destNext = path.join(destOffice, '.next')
  fs.mkdirSync(destNext, { recursive: true })

  let copied = 0
  const copyRootFile = (srcPath, name) => {
    const dest = path.join(destNext, name)
    if (fs.existsSync(dest)) return
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) return
    fs.copyFileSync(srcPath, dest)
    copied++
  }

  for (const root of [srcNext, standaloneNext]) {
    if (!fs.existsSync(root)) continue
    for (const name of fs.readdirSync(root)) {
      const srcPath = path.join(root, name)
      if (!fs.statSync(srcPath).isFile()) continue
      if (name === 'BUILD_ID' || name.endsWith('.json')) {
        copyRootFile(srcPath, name)
      }
    }
  }

  const srcServer = path.join(srcNext, 'server')
  const destServer = path.join(destNext, 'server')
  if (fs.existsSync(srcServer) && !fs.existsSync(path.join(destServer, 'pages-manifest.json'))) {
    packCpSync(srcServer, destServer)
    copied++
  }

  const srcStatic = path.join(srcNext, 'static')
  const destStatic = path.join(destNext, 'static')
  if (fs.existsSync(srcStatic) && !fs.existsSync(destStatic)) {
    packCpSync(srcStatic, destStatic)
    copied++
  }

  return copied
}

module.exports = {
  CRITICAL_NEXT_ROOT,
  missingCriticalNextRoot,
  officeNextRootReady,
  syncOfficeNextRootManifests
}
