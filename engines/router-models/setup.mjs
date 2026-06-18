#!/usr/bin/env node
/** Packaged-app entry — delegates to run-setup.mjs in the same folder. */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const script = join(dir, 'run-setup.mjs')
const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
