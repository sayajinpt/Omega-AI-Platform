#!/usr/bin/env node
/**
 * Audit SDK IPC channel coverage vs native HTTP routes.
 * Run: node scripts/audit-main-responsibilities.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ipcPath = join(root, 'apps/desktop/src/shared/ipc.ts')
const httpMapPath = join(root, 'packages/sdk/src/ipc-http-map.generated.ts')
const runtimeSrc = join(root, 'apps/runtime/src')

function countFiles(dir, ext) {
  let n = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) n += countFiles(p, ext)
    else if (name.endsWith(ext)) n += 1
  }
  return n
}

function extractIpcChannels(source) {
  const channels = []
  const re = /:\s*'(omega:[^']+)'/g
  let m
  while ((m = re.exec(source)) !== null) channels.push(m[1])
  return channels
}

function extractHttpMappedChannels(source) {
  const channels = []
  const re = /"(omega:[^"]+)":/g
  let m
  while ((m = re.exec(source)) !== null) channels.push(m[1])
  return channels
}

const ipcSrc = readFileSync(ipcPath, 'utf8')
const httpSrc = readFileSync(httpMapPath, 'utf8')
const channels = extractIpcChannels(ipcSrc)
const httpMapped = extractHttpMappedChannels(httpSrc)
const runtimeCpp = countFiles(runtimeSrc, '.cpp')

console.log('Omega runtime audit')
console.log('===================')
console.log(`omega-runtime C++ sources: ${runtimeCpp}`)
console.log(`SDK IPC channels (ipc.ts): ${channels.length}`)
console.log(`Native HTTP mappings: ${httpMapped.length}`)
console.log('')

const unmapped = channels.filter((c) => !httpMapped.includes(c))
console.log(`IPC channels without HTTP route: ${unmapped.length}`)
if (unmapped.length && unmapped.length <= 40) {
  for (const ch of unmapped) console.log(`  ${ch}`)
} else if (unmapped.length > 40) {
  for (const ch of unmapped.slice(0, 20)) console.log(`  ${ch}`)
  console.log(`  … and ${unmapped.length - 20} more`)
}
