#!/usr/bin/env node
/**
 * Build omega-infer (llama-server) from synced llama.cpp when GitHub prebuilts are missing.
 *
 * Usage: node scripts/build-infer-from-source.mjs win-cuda [--force]
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInferFromSource } from './lib/build-infer-source.mjs'
import { readPrimaryVariant } from './lib/llama-lock.mjs'
import { assertHostOs, resolveVariant } from './lib/llama-variants.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force')
const variantArg = process.argv.slice(2).find((a) => !a.startsWith('-'))

let variant = null
let tag = null
if (variantArg) {
  variant = resolveVariant(variantArg)
} else {
  const { variant: v, tag: t } = readPrimaryVariant(root)
  variant = v
  tag = t
}
if (!variant) {
  console.error('Usage: node scripts/build-infer-from-source.mjs <variant-id> [--force]')
  process.exit(1)
}
assertHostOs(variant)

buildInferFromSource({ root, variant, force, tag })
console.log(`\n[build-infer-from-source] Done: ${variant.id}\n`)
