#!/usr/bin/env node
/**
 * Packaged copy of scripts/setup-sidecar-engines.mjs (electron-builder extraResources).
 * Delegates to repo script in dev; self-contained when only engines/sidecar is shipped.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const localScript = join(here, 'run-setup.mjs')
const target = existsSync(localScript) ? localScript : join(here, '..', '..', 'scripts', 'setup-sidecar-engines.mjs')
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
