#!/usr/bin/env node
/**
 * Benchmark Qwen3 8B via bundled omega-infer (llama-server) HTTP API.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BIN_DIR = join(repoRoot, 'dist', 'bin')
const INFER = join(BIN_DIR, process.platform === 'win32' ? 'omega-infer.exe' : 'omega-infer')
const MODEL =
  process.env.OMEGA_BENCH_MODEL ??
  join(process.env.USERPROFILE || '', '.omega', 'models', 'Qwen_Qwen3-8B-GGUF', 'Qwen_Qwen3-8B-Q4_K_M.gguf')
const PROMPT = 'The capital of France is'
const MAX_TOKENS = 64
const TEMP = 0.1

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => resolvePort(typeof addr === 'object' && addr ? addr.port : 0))
    })
    srv.on('error', reject)
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitHealth(port, ms = 120_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      if (r.ok) return
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error('omega-infer health timeout')
}

async function main() {
  if (!existsSync(MODEL)) {
    console.error('Model missing:', MODEL)
    process.exit(1)
  }
  if (!existsSync(INFER)) {
    console.error('omega-infer missing:', INFER)
    process.exit(1)
  }

  const port = await freePort()
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const env = {
    ...process.env,
    PATH: `${BIN_DIR}${pathSep}${process.env.PATH ?? ''}`
  }

  console.log('omega-infer (llama.cpp server) benchmark')
  console.log('Model:', MODEL)
  console.log('Port:', port)

  const loadStart = Date.now()
  const proc = spawn(
    INFER,
    [
      '-m',
      MODEL,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-ngl',
      '99',
      '-c',
      '8192',
      '--flash-attn',
      'on',
      '--parallel',
      '1'
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  proc.stderr?.on('data', (b) => {
    const s = b.toString().trim()
    if (s) console.error('[infer]', s.slice(0, 300))
  })

  await waitHealth(port)
  const loadMs = Date.now() - loadStart

  // warmup
  await fetch(`http://127.0.0.1:${port}/v1/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Hi',
      max_tokens: 8,
      temperature: TEMP,
      stream: false
    })
  })

  let firstTokenMs = null
  const genStart = Date.now()
  const res = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: PROMPT,
      max_tokens: MAX_TOKENS,
      temperature: TEMP,
      stream: true
    })
  })
  if (!res.ok) throw new Error(`completions HTTP ${res.status}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  let tokens = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') continue
      try {
        const j = JSON.parse(payload)
        const chunk = j.choices?.[0]?.text ?? ''
        if (chunk) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - genStart
          text += chunk
          tokens++
        }
      } catch {
        /* ignore */
      }
    }
  }
  const genMs = Date.now() - genStart
  const tps = genMs > 0 ? (tokens / genMs) * 1000 : 0

  proc.kill('SIGTERM')

  const result = {
    backend: 'omega-infer (llama.cpp / llama-server)',
    load_ms: loadMs,
    first_token_ms: firstTokenMs ?? genMs,
    gen_ms: genMs,
    tokens,
    tokens_per_sec: Number(tps.toFixed(2)),
    sample: text.trim().slice(0, 120)
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
