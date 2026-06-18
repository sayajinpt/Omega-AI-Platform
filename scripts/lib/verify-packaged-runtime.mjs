#!/usr/bin/env node
/**
 * Ensure packaged omega-runtime matches dist/runtime (same bytes / build tag).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const RUNTIME_NAME = process.platform === 'win32' ? 'omega-runtime.exe' : 'omega-runtime'

export function readRuntimeBuildTag(exePath) {
  if (!existsSync(exePath)) return null
  const buf = readFileSync(exePath)
  const text = buf.toString('latin1')
  const tags = text.match(/cs-[a-z0-9-]+-\d{8}/g)
  return tags ? tags[tags.length - 1] : null
}

export function verifyPackagedRuntime(root, { destPath, fix = false } = {}) {
  const src = join(root, 'dist', 'runtime', RUNTIME_NAME)
  const dest = destPath ?? join(root, 'dist', 'native', 'Omega', 'runtime', RUNTIME_NAME)
  if (!existsSync(src)) {
    throw new Error(`missing ${src} — run: npm run build:runtime`)
  }
  if (!existsSync(dest)) {
    if (!fix) {
      throw new Error(`packaged runtime missing: ${dest}`)
    }
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    return { src, dest, copied: true, srcTag: readRuntimeBuildTag(src), destTag: readRuntimeBuildTag(dest) }
  }

  const srcStat = statSync(src)
  const destStat = statSync(dest)
  const srcTag = readRuntimeBuildTag(src)
  const destTag = readRuntimeBuildTag(dest)

  const stale =
    srcStat.mtimeMs > destStat.mtimeMs + 1000 ||
    srcStat.size !== destStat.size ||
    (srcTag && destTag && srcTag !== destTag)

  if (stale && fix) {
    copyFileSync(src, dest)
    return { src, dest, copied: true, srcTag, destTag: readRuntimeBuildTag(dest), wasStale: true }
  }
  if (stale) {
    throw new Error(
      `packaged runtime is stale (${basename(dest)} tag=${destTag ?? 'unknown'} mtime=${destStat.mtime.toISOString()}) ` +
        `vs dist/runtime (tag=${srcTag ?? 'unknown'} mtime=${srcStat.mtime.toISOString()})`
    )
  }
  return { src, dest, copied: false, srcTag, destTag }
}
