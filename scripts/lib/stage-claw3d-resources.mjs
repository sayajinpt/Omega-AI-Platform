/**
 * Stage built Claw3D office into packaged resources/claw3d-office.
 * Build output lives under apps/desktop/claw3d-office (see ensure-claw3d-office.mjs).
 */
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { claw3dOfficeRoot, claw3dPackReady, claw3dStandaloneAppDir } from './claw3d-standalone.mjs'

/**
 * Copy claw3d-office for installer: keep .next production build, drop dev node_modules.
 * @param {string} src
 * @param {string} dest
 */
export function copyClaw3dOfficeForPack(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const norm = srcPath.replace(/\\/g, '/')
      const rel = norm.startsWith(src.replace(/\\/g, '/'))
        ? norm.slice(src.replace(/\\/g, '/').length)
        : norm
      if (!rel || rel === '/') return true
      if (/\/node_modules(\/|$)/.test(rel) && !/\.next\/standalone\//.test(norm)) return false
      if (/\/\.git(\/|$)/.test(rel)) return false
      if (/\/__pycache__(\/|$)/.test(rel)) return false
      return true
    }
  })
}

/**
 * @param {string} repoRoot
 * @param {string} resourcesDir e.g. dist/native/Omega/resources
 */
export function stageClaw3dOffice(repoRoot, resourcesDir) {
  const claw3dSrc = claw3dOfficeRoot(repoRoot)
  const claw3dReady = claw3dPackReady(repoRoot)
  if (!claw3dReady.ok) {
    throw new Error(
      `claw3d-office not ready: ${claw3dReady.reason}\n` +
        'Run build.bat (or your platform build script) — it runs ensure-claw3d-office automatically.'
    )
  }
  const dest = join(resourcesDir, 'claw3d-office')
  console.log('[package-native] staging claw3d-office from', claw3dSrc)
  copyClaw3dOfficeForPack(claw3dSrc, dest)
  const marker = join(dest, '.next', 'BUILD_ID')
  if (!existsSync(marker)) {
    throw new Error('claw3d-office staged without .next/BUILD_ID — packaging filter may have stripped the build')
  }
  const standaloneNmDir = join(claw3dStandaloneAppDir(dest), 'node_modules')
  if (!existsSync(join(standaloneNmDir, 'next', 'package.json'))) {
    throw new Error(
      'claw3d-office staged without .next/standalone/node_modules — installer prune may have removed the Next trace'
    )
  }
  if (!existsSync(join(standaloneNmDir, 'baseline-browser-mapping', 'package.json'))) {
    throw new Error(
      'claw3d-office staged without baseline-browser-mapping — run build.bat (Claw3D server-deps)'
    )
  }
  if (!existsSync(join(standaloneNmDir, 'caniuse-lite', 'package.json'))) {
    throw new Error('claw3d-office staged without caniuse-lite — run build.bat (Claw3D server-deps)')
  }
}
