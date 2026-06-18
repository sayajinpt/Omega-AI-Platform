#!/usr/bin/env node
/**
 * Dev-only: verify GGUF tensor offset in a local model file.
 * Usage: node scripts/verify-gguf-offset.mjs [path-to.gguf]
 */
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const defaultModel = join(
  homedir(),
  '.omega',
  'models',
  'Qwen_Qwen3-8B-GGUF',
  'Qwen_Qwen3-8B-Q4_K_M.gguf'
)
const p = process.argv[2]?.trim() || process.env.OMEGA_TEST_GGUF || defaultModel
const fh = await open(p, 'r')

let off = 0
async function read(n) {
  const b = Buffer.alloc(n)
  await fh.read(b, 0, n, off)
  off += n
  return b
}
async function u32() {
  return (await read(4)).readUInt32LE(0)
}
async function u64() {
  return (await read(8)).readBigUInt64LE(0)
}
async function str() {
  const n = Number(await u64())
  return (await read(n)).toString('utf8')
}
async function skipVal(t) {
  if (t === 8) {
    const n = Number(await u64())
    off += n
    return
  }
  if (t === 9) {
    const et = await u32()
    const n = Number(await u64())
    for (let i = 0; i < n; i++) await skipVal(et)
    return
  }
  if (t === 4 || t === 5 || t === 6) {
    off += 4
    return
  }
  throw new Error(`skip ${t}`)
}

console.log('GGUF:', p)

await read(4) // magic
const ver = await u32()
console.log('ver', ver)
const tc = Number(await u64())
const kc = Number(await u64())
console.log('kv', kc)

for (let i = 0; i < kc; i++) {
  const key = await str()
  const vt = await u32()
  const pos = off
  if (key === 'tokenizer.ggml.merges') {
    const et = await u32()
    const n = Number(await u64())
    const data = off
    const b = await read(16)
    off -= 16
    console.log('merges hdr', { pos, et, n, data, hex: b.toString('hex') })
    const ln = Number(await u64())
    console.log('first len', ln, 'at', off - 8)
    break
  }
  await skipVal(vt)
  if (key.startsWith('tokenizer.')) console.log(key, '->', off)
}

await fh.close()
