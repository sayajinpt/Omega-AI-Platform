#!/usr/bin/env node
/**
 * @deprecated node-llama-cpp was removed. Use llama-build-variant.mjs or llama-setup.mjs instead.
 */
console.error(
  '[build-llama-variant] node-llama-cpp source builds were removed.\n' +
    '  Use: node scripts/llama-build-variant.mjs <variant-id>\n' +
    '  Or:  node scripts/llama-setup.mjs --installer'
)
process.exit(1)
