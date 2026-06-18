#!/usr/bin/env node
/**
 * Compare Qwen3 8B inference: node-llama-cpp (Omega native / llama.cpp) vs bundled omega-ollama.
 *
 * Usage: node scripts/bench-qwen8b.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MODEL_PATH =
  process.env.OMEGA_BENCH_MODEL ??
  join(process.env.USERPROFILE || '', '.omega', 'models', 'Qwen_Qwen3-8B-GGUF', 'Qwen_Qwen3-8B-Q4_K_M.gguf')
const PROMPT = 'The capital of France is'
const MAX_TOKENS = 64
const TEMP = 0.1
const OLLAMA_EXE = join(repoRoot, 'dist', 'bin', process.platform === 'win32' ? 'omega-ollama.exe' : 'omega-ollama')
const MODELS_DIR = join(process.env.USERPROFILE || '', '.omega', 'models')

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

async function benchNodeLlamaCpp() {
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp')

  const loadStart = Date.now()
  const llama = await getLlama({ gpu: 'auto' })
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 99 })
  const ctx = await model.createContext({ contextSize: 8192 })
  const session = new LlamaChatSession({ contextSequence: ctx.getSequenceForChatSession() })
  const loadMs = Date.now() - loadStart

  // warmup
  await session.prompt('Hi', { maxTokens: 8, temperature: TEMP })

  let genTokens = 0
  let firstTokenMs = null
  const genStart = Date.now()
  const text = await session.prompt(PROMPT, {
    maxTokens: MAX_TOKENS,
    temperature: TEMP,
    onTextChunk() {
      genTokens++
      if (firstTokenMs === null) firstTokenMs = Date.now() - genStart
    }
  })
  const genMs = Date.now() - genStart

  await ctx.dispose()
  await model.dispose()
  await llama.dispose()

  const decodeTps = genMs > 0 ? (genTokens / genMs) * 1000 : 0
  return {
    backend: 'node-llama-cpp (Omega native / llama.cpp)',
    load_ms: loadMs,
    first_token_ms: firstTokenMs ?? genMs,
    gen_ms: genMs,
    tokens: genTokens,
    tokens_per_sec: Number(decodeTps.toFixed(2)),
    sample: text.trim().slice(0, 120)
  }
}

async function startOllama(port) {
  return new Promise((resolveStart, reject) => {
    const proc = spawn(OLLAMA_EXE, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: `127.0.0.1:${port}`,
        OLLAMA_MODELS: MODELS_DIR,
        OLLAMA_KEEP_ALIVE: '30m',
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_NOPRUNE: '1',
        OLLAMA_DEBUG: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const deadline = Date.now() + 45_000
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/version`)
        if (r.ok) return resolveStart(proc)
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) {
        proc.kill()
        reject(new Error('omega-ollama did not start in time'))
        return
      }
      setTimeout(tick, 400)
    }
    tick()
  })
}

async function ensureOllamaModel(port, name) {
  const modelfile = `FROM ${MODEL_PATH.replace(/\\/g, '/')}\n`
  const mfPath = join(MODELS_DIR, 'bench-Modelfile.txt')
  writeFileSync(mfPath, modelfile, 'utf8')
  await new Promise((resolveRun, reject) => {
    const p = spawn(OLLAMA_EXE, ['create', name, '-f', mfPath], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: MODELS_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
    let err = ''
    p.stderr?.on('data', (b) => {
      err += b.toString()
    })
    p.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(err || `ollama create exit ${code}`))))
    p.on('error', reject)
  })
  try {
    unlinkSync(mfPath)
  } catch {
    /* ignore */
  }
}

async function benchOllama(proc, port) {
  const modelName = 'bench-qwen3-8b'
  const createStart = Date.now()
  await ensureOllamaModel(port, modelName)
  const createMs = Date.now() - createStart

  let evalCount = 0
  let loadMs = 0
  let firstTokenMs = null
  let totalMs = 0
  const genStart = Date.now()

  const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      prompt: PROMPT,
      stream: true,
      options: { temperature: TEMP, num_predict: MAX_TOKENS }
    })
  })
  if (!res.ok) throw new Error(`ollama generate HTTP ${res.status}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let sample = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const j = JSON.parse(line)
      if (j.response) sample += j.response
      if (j.eval_count) evalCount = j.eval_count
      if (typeof j.load_duration === 'number') loadMs = j.load_duration / 1e6
      if (typeof j.eval_duration === 'number' && j.eval_duration > 0) {
        totalMs = j.eval_duration / 1e6
      }
      if (firstTokenMs === null && j.response) {
        firstTokenMs = Date.now() - genStart
      }
    }
  }

  const wallMs = Date.now() - genStart
  const tps =
    totalMs > 0 && evalCount > 0
      ? (evalCount / totalMs) * 1000
      : wallMs > 0
        ? (evalCount / wallMs) * 1000
        : 0

  return {
    backend: 'omega-ollama (Ollama runtime)',
    model_register_ms: createMs,
    load_ms: Math.round(loadMs) || createMs,
    first_token_ms: firstTokenMs ?? wallMs,
    gen_ms: Math.round(totalMs) || wallMs,
    tokens: evalCount,
    tokens_per_sec: Number(tps.toFixed(2)),
    sample: sample.trim().slice(0, 120)
  }
}

async function main() {
  if (!existsSync(MODEL_PATH)) {
    console.error(`Model not found: ${MODEL_PATH}`)
    process.exit(1)
  }
  if (!existsSync(OLLAMA_EXE)) {
    console.error(`omega-ollama not found: ${OLLAMA_EXE} — run build-win.bat first`)
    process.exit(1)
  }

  console.log('Omega Qwen3 8B benchmark')
  console.log(`Model: ${MODEL_PATH}`)
  console.log(`Prompt: "${PROMPT}" · max_tokens=${MAX_TOKENS} · temp=${TEMP}\n`)

  const results = []

  console.log('--- node-llama-cpp (direct llama.cpp, same stack as Omega native) ---')
  try {
    const r = await benchNodeLlamaCpp()
    results.push(r)
    console.log(JSON.stringify(r, null, 2))
  } catch (e) {
    console.error('node-llama-cpp failed:', e instanceof Error ? e.message : e)
  }

  console.log('\n--- omega-ollama ---')
  let ollamaProc = null
  try {
    const port = await freePort()
    ollamaProc = await startOllama(port)
    const r = await benchOllama(ollamaProc, port)
    results.push(r)
    console.log(JSON.stringify(r, null, 2))
  } catch (e) {
    console.error('ollama failed:', e instanceof Error ? e.message : e)
  } finally {
    if (ollamaProc) {
      try {
        ollamaProc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }

  if (results.length === 2) {
    const native = results[0]
    const ollama = results[1]
    const ratio =
      ollama.tokens_per_sec > 0
        ? (native.tokens_per_sec / ollama.tokens_per_sec).toFixed(2)
        : 'n/a'
    console.log('\n=== Summary ===')
    console.log(
      `Decode speed: native ${native.tokens_per_sec} tok/s vs Ollama ${ollama.tokens_per_sec} tok/s (${ratio}x)`
    )
    console.log(
      `Time to first token (wall): native ~${native.first_token_ms} ms vs Ollama ~${ollama.first_token_ms} ms`
    )
    console.log(`Model load (reported): native ${native.load_ms} ms vs Ollama ${ollama.load_ms} ms`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
