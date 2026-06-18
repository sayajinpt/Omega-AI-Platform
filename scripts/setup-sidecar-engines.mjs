#!/usr/bin/env node
/** Dev entry — see engines/sidecar/run-setup.mjs */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'engines', 'sidecar', 'run-setup.mjs')
const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
