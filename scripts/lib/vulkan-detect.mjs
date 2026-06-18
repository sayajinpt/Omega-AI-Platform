/**
 * Detect LunarG Vulkan SDK (headers + glslc) for building libomega_infer with GGML_VULKAN.
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** @typedef {{ root: string, label: string, glslc: string, source: string }} VulkanInstallInfo */

/** @param {string} root */
function probeVulkanRoot(root) {
  if (!root || !existsSync(root)) return null
  const glslcName = process.platform === 'win32' ? 'glslc.exe' : 'glslc'
  const glslc = join(root, 'Bin', glslcName)
  const header = join(root, 'Include', 'vulkan', 'vulkan.h')
  if (!existsSync(glslc) || !existsSync(header)) return null
  return {
    root,
    label: `Vulkan SDK (${root})`,
    glslc,
    source: 'layout'
  }
}

/** @param {string} glslc */
function inferRootFromGlslc(glslc) {
  if (!glslc || !existsSync(glslc)) return null
  const binDir = dirname(glslc)
  if (basename(binDir).toLowerCase() !== 'bin') return null
  return probeVulkanRoot(dirname(binDir))
}

/** @param {string} sdkRoot */
function scanVersionedSdkRoots(sdkRoot) {
  if (!existsSync(sdkRoot)) return /** @type {VulkanInstallInfo[]} */ ([])
  const hits = []
  const direct = probeVulkanRoot(sdkRoot)
  if (direct) hits.push(direct)
  try {
    for (const name of readdirSync(sdkRoot, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const hit = probeVulkanRoot(join(sdkRoot, name.name))
      if (hit) hits.push(hit)
    }
  } catch {
    /* ignore unreadable roots */
  }
  hits.sort((a, b) => b.root.localeCompare(a.root))
  return hits
}

/** @returns {VulkanInstallInfo | null} */
function detectFromEnv() {
  const candidates = [
    process.env.VULKAN_SDK?.trim(),
    process.env.OMEGA_VULKAN_SDK?.trim(),
    ...(process.platform === 'win32' ? readWindowsVulkanSdkEnvVars() : [])
  ].filter(Boolean)
  for (const raw of candidates) {
    const direct = probeVulkanRoot(raw)
    if (direct) {
      direct.source = raw === process.env.OMEGA_VULKAN_SDK ? 'OMEGA_VULKAN_SDK' : 'VULKAN_SDK'
      return direct
    }
    if (process.platform === 'win32' && /^C:\\VulkanSDK/i.test(raw)) {
      const scanned = scanVersionedSdkRoots(raw)
      if (scanned.length) {
        scanned[0].source = 'VULKAN_SDK'
        return scanned[0]
      }
    }
  }
  return null
}

/** Read Machine/User VULKAN_SDK when the build shell has not picked up a fresh install yet. */
function readWindowsVulkanSdkEnvVars() {
  /** @type {string[]} */
  const out = []
  const queries = [
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Machine'],
    ['HKCU\\Environment', 'User']
  ]
  for (const [key, label] of queries) {
    try {
      const raw = execSync(`reg query "${key}" /v VULKAN_SDK`, {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      const m = raw.match(/^\s*VULKAN_SDK\s+REG_\w+\s+(.+)\s*$/im)
      if (m?.[1]) out.push(m[1].trim())
    } catch {
      /* key or value missing */
    }
  }
  return out
}

/** @returns {VulkanInstallInfo | null} */
function detectFromRegistry() {
  if (process.platform !== 'win32') return null
  /** @type {VulkanInstallInfo[]} */
  const hits = []
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execSync(`reg query "${hive}\\SOFTWARE\\Khronos\\Vulkan\\SDK" /s`, {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*InstallationDir\s+REG_\w+\s+(.+)\s*$/i)
        if (!m) continue
        const hit = probeVulkanRoot(m[1].trim())
        if (hit) {
          hit.source = `${hive}\\SOFTWARE\\Khronos\\Vulkan\\SDK`
          hits.push(hit)
        }
      }
    } catch {
      /* key missing */
    }
  }
  if (!hits.length) return null
  hits.sort((a, b) => b.root.localeCompare(a.root))
  return hits[0]
}

/** @returns {VulkanInstallInfo | null} */
function detectFromDefaultDirs() {
  if (process.platform === 'win32') {
    const scanned = scanVersionedSdkRoots('C:\\VulkanSDK')
    if (!scanned.length) return null
    scanned[0].source = 'C:\\VulkanSDK'
    return scanned[0]
  }
  for (const root of ['/usr', '/usr/local']) {
    const hit = probeVulkanRoot(root)
    if (hit) {
      hit.source = root
      return hit
    }
  }
  return null
}

/** @returns {VulkanInstallInfo | null} */
function detectFromPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where glslc' : 'which glslc'
    const out = execSync(cmd, { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim()
    const first = out.split(/\r?\n/).find(Boolean)
    if (!first) return null
    const glslc = first.trim()
    const inferred = inferRootFromGlslc(glslc)
    if (inferred) {
      inferred.source = 'PATH'
      return inferred
    }
    if (!existsSync(glslc)) return null
    return {
      root: '',
      label: `glslc on PATH (${glslc})`,
      glslc,
      source: 'PATH'
    }
  } catch {
    return null
  }
}

/** @param {VulkanInstallInfo} a @param {VulkanInstallInfo} b */
function preferVulkanInstall(a, b) {
  if (a.root && !b.root) return a
  if (b.root && !a.root) return b
  if (a.root && b.root) return a.root.localeCompare(b.root) > 0 ? a : b
  return a
}

/** @param {VulkanInstallInfo} hit */
function normalizeVulkanInstall(hit) {
  if (hit.root) return hit
  const inferred = inferRootFromGlslc(hit.glslc)
  if (!inferred) return hit
  return { ...inferred, source: hit.source || inferred.source }
}

/** Detect Vulkan SDK suitable for compiling ggml-vulkan. */
export function detectInstalledVulkan() {
  const chain = [detectFromEnv, detectFromRegistry, detectFromDefaultDirs, detectFromPath]
  /** @type {VulkanInstallInfo | null} */
  let best = null
  for (const fn of chain) {
    const hit = fn()
    if (!hit) continue
    const normalized = normalizeVulkanInstall(hit)
    best = best ? preferVulkanInstall(best, normalized) : normalized
  }
  return best
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {VulkanInstallInfo | null | undefined} vulkan
 */
export function applyVulkanSdkToEnv(env, vulkan) {
  const info = vulkan ? normalizeVulkanInstall(vulkan) : detectInstalledVulkan()
  if (!info?.root) return env
  env.VULKAN_SDK = info.root
  const bin = join(info.root, 'Bin')
  if (existsSync(bin)) {
    env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`
  }
  return env
}
