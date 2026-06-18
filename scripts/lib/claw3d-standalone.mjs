/**
 * Claw3D office paths for build + installer packaging (Next standalone output).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string} repoRoot Omega repo root */
export function claw3dOfficeRoot(repoRoot) {
  return join(repoRoot, 'apps', 'desktop', 'claw3d-office')
}

/**
 * `.next/standalone` app root (flat or legacy monorepo-nested layout).
 * @param {string} officeRoot
 */
export function claw3dStandaloneAppDir(officeRoot) {
  const flat = join(officeRoot, '.next', 'standalone')
  const nested = join(flat, 'apps', 'desktop', 'claw3d-office')
  if (existsSync(join(nested, 'server.js'))) return nested
  return flat
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function claw3dPackReady(repoRoot) {
  const office = claw3dOfficeRoot(repoRoot)
  if (!existsSync(join(office, '.next', 'BUILD_ID'))) {
    return { ok: false, reason: '.next/BUILD_ID missing — run build.bat (includes Claw3D office build)' }
  }
  if (!existsSync(join(office, 'server', 'index.js'))) {
    return { ok: false, reason: 'server/index.js missing' }
  }
  const standalone = claw3dStandaloneAppDir(office)
  const standaloneNm = join(standalone, 'node_modules')
  if (!existsSync(join(standaloneNm, 'next', 'package.json'))) {
    return {
      ok: false,
      reason: '.next/standalone trace missing — run build.bat (includes Claw3D office build)'
    }
  }
  if (!existsSync(join(standaloneNm, 'ws', 'package.json'))) {
    return {
      ok: false,
      reason: 'server runtime dep ws missing in standalone — run build.bat (includes Claw3D office build)'
    }
  }
  if (!existsSync(join(standaloneNm, 'baseline-browser-mapping', 'package.json'))) {
    return {
      ok: false,
      reason:
        'baseline-browser-mapping missing in standalone — run build.bat (Claw3D server-deps refresh)'
    }
  }
  if (!existsSync(join(standaloneNm, 'caniuse-lite', 'package.json'))) {
    return {
      ok: false,
      reason: 'caniuse-lite missing in standalone — run build.bat (Claw3D server-deps refresh)'
    }
  }
  return { ok: true }
}
