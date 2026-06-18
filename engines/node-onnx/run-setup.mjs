#!/usr/bin/env node
/**
 * Install onnxruntime-node + @huggingface/tokenizers under ~/.omega/venvs/node-onnx/
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const omegaHome = process.env.OMEGA_HOME ?? join(homedir(), '.omega')
const venvDir = join(omegaHome, 'venvs', 'node-onnx')

function progress(phase, detail) {
  console.log(`OMEGA_NODE_ONNX_PROGRESS:${phase}|${detail}`)
}

function pathDirs() {
  const sep = process.platform === 'win32' ? ';' : ':'
  return (process.env.Path ?? process.env.PATH ?? '').split(sep).map((p) => p.trim()).filter(Boolean)
}

function resolveNode() {
  const explicit = process.env.OMEGA_NODE_EXE?.trim()
  if (explicit && existsSync(explicit)) return explicit

  for (const dir of pathDirs()) {
    const node = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(node)) return node
  }

  if (process.platform === 'win32') {
    const candidates = [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe')
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
  }
  return null
}

/** Run npm via node + npm-cli.js (works when npm is not on PATH). */
function resolveNpmRunner(node) {
  const npmCli = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return { cmd: node, prefix: [npmCli] }
  }
  const npmCmd = join(dirname(node), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (existsSync(npmCmd)) {
    return { cmd: npmCmd, prefix: [] }
  }
  return null
}

function runNpm(npmRunner, args, label) {
  console.log(`[setup:node-onnx] ${label}…`)
  const nodeDir = dirname(resolveNode() || '')
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const env = {
    ...process.env,
    [pathKey]: nodeDir ? `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}` : process.env[pathKey]
  }
  const r = spawnSync(npmRunner.cmd, [...npmRunner.prefix, ...args], {
    cwd: venvDir,
    stdio: 'pipe',
    encoding: 'utf8',
    env,
    shell: false
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    console.error(`[setup:node-onnx] failed: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

const node = resolveNode()
if (!node) {
  console.error(
    '[setup:node-onnx] Node.js not found. Install Node.js LTS from https://nodejs.org/ ' +
      'then fully quit and restart Omega.'
  )
  process.exit(1)
}

const npmRunner = resolveNpmRunner(node)
if (!npmRunner) {
  console.error(
    `[setup:node-onnx] npm not found next to Node (${node}). Reinstall Node.js LTS (includes npm).`
  )
  process.exit(1)
}

const npmVer = spawnSync(npmRunner.cmd, [...npmRunner.prefix, '--version'], {
  encoding: 'utf8',
  env: process.env,
  shell: false
})
if (npmVer.status !== 0 || !npmVer.stdout?.trim()) {
  console.error('[setup:node-onnx] npm --version failed')
  process.exit(1)
}
console.log(`[setup:node-onnx] using Node ${node} · npm ${npmVer.stdout.trim()}`)

progress('starting', 'Installing router ONNX runtime (onnxruntime-node)')
mkdirSync(venvDir, { recursive: true })

writeFileSync(
  join(venvDir, 'package.json'),
  JSON.stringify(
    {
      name: 'omega-node-onnx',
      private: true,
      description: 'Smart-input router — onnxruntime-node + tokenizers',
      dependencies: {
        'onnxruntime-node': '^1.21.0',
        '@huggingface/tokenizers': '^0.0.5'
      }
    },
    null,
    2
  ),
  'utf8'
)

progress('packages', 'Downloading onnxruntime-node and tokenizers (may take a few minutes)')
runNpm(npmRunner, ['install', '--omit=dev', '--no-fund', '--no-audit'], 'npm install')

const ortPkg = join(venvDir, 'node_modules', 'onnxruntime-node', 'package.json')
const tokPkg = join(venvDir, 'node_modules', '@huggingface', 'tokenizers', 'package.json')
if (!existsSync(ortPkg) || !existsSync(tokPkg)) {
  console.error('[setup:node-onnx] install finished but packages are missing')
  process.exit(1)
}

progress('verify', 'Verifying onnxruntime-node load')
const check = spawnSync(
  node,
  [
    '-e',
    "require('onnxruntime-node'); require('@huggingface/tokenizers'); console.log('ok')"
  ],
  {
    cwd: venvDir,
    env: { ...process.env, NODE_PATH: join(venvDir, 'node_modules') },
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false
  }
)
if (check.status !== 0) {
  if (check.stdout) process.stdout.write(check.stdout)
  if (check.stderr) process.stderr.write(check.stderr)
  console.error('[setup:node-onnx] verify failed — packages installed but import check failed')
  process.exit(1)
}

progress('done', `Router ONNX runtime ready at ${venvDir}`)
console.log(`[setup:node-onnx] node_modules: ${join(venvDir, 'node_modules')}`)
