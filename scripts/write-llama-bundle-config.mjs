#!/usr/bin/env node
/**
 * Stage node-llama-cpp for resources/llama-js (legacy llama-js bundle; native runtime uses omega-engine).
 */
import { stageLlamaPackBundle, verifyStagedLlamaImports } from './node-llama-pack-deps.mjs'

const { staged } = stageLlamaPackBundle()
console.log(`[packaging] staged ${staged} package paths (llama-js bundle)`)

const verify = verifyStagedLlamaImports()
if (!verify.ok) {
  console.error('[packaging] staged import verification failed — missing resolves:')
  for (const m of verify.missing.slice(0, 40)) console.error(`  - ${m}`)
  if (verify.missing.length > 40) {
    console.error(`  … and ${verify.missing.length - 40} more`)
  }
  process.exit(1)
}
console.log('[packaging] staged import verification passed')
