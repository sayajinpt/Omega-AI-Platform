import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isCudaRuntimeDll,
  stripDuplicateCudaRuntimeFromEngine,
  ensureCudaRuntimeHardlinks
} from './cuda-runtime-shared.mjs'

assert.equal(isCudaRuntimeDll('cublasLt64_13.dll'), true)
assert.equal(isCudaRuntimeDll('ggml-cuda.dll'), false)

const root = join(tmpdir(), `omega-cuda-dedupe-${Date.now()}`)
const binDir = join(root, 'dist', 'bin')
const engineDir = join(root, 'dist', 'engine')
mkdirSync(binDir, { recursive: true })
mkdirSync(engineDir, { recursive: true })

writeFileSync(join(binDir, 'cublasLt64_13.dll'), Buffer.alloc(1024))
writeFileSync(join(binDir, 'cublas64_13.dll'), Buffer.alloc(512))
writeFileSync(join(engineDir, 'cublasLt64_13.dll'), Buffer.alloc(2048))
writeFileSync(join(engineDir, 'omega_infer.dll'), Buffer.alloc(128))
writeFileSync(join(engineDir, 'cublas64_13.dll'), Buffer.alloc(256))

const result = stripDuplicateCudaRuntimeFromEngine(root)
assert.deepEqual(result.removed.sort(), ['cublas64_13.dll', 'cublasLt64_13.dll'])
assert.equal(existsSync(join(engineDir, 'omega_infer.dll')), true)
assert.equal(existsSync(join(engineDir, 'cublasLt64_13.dll')), false)

const linked = ensureCudaRuntimeHardlinks(engineDir, binDir)
assert.deepEqual(linked.linked.sort(), ['cublas64_13.dll', 'cublasLt64_13.dll'])
assert.equal(readFileSync(join(engineDir, 'cublasLt64_13.dll')).length, 1024)

rmSync(root, { recursive: true, force: true })
console.log('cuda-runtime-shared.test.mjs OK')
