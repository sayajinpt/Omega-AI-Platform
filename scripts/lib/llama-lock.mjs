import { readSetupLock } from './llama-github.mjs'
import { resolveVariant, variantsForHost } from './llama-variants.mjs'

/**
 * Primary GPU variant for this machine (from lock or sole entry).
 * @param {import('./llama-github.mjs').readSetupLock extends (...args: any) => infer R ? R : never} lock
 * @returns {import('./llama-variants.mjs').VariantId | null}
 */
export function primaryVariantId(lock) {
  if (!lock) return null
  const explicit = lock.primaryVariant?.trim()
  if (explicit) return explicit

  const keys = Object.keys(lock.variants ?? {})
  if (keys.length === 1) return keys[0]

  const hostIds = variantsForHost().map((v) => v.id)
  const onHost = keys.filter((k) => hostIds.includes(k))
  if (onHost.length === 1) return onHost[0]
  if (onHost.length > 1) return onHost[onHost.length - 1]

  return keys[0] ?? null
}

/** @param {string} root */
export function readPrimaryVariant(root) {
  const lock = readSetupLock(root)
  const id = primaryVariantId(lock)
  if (!id) return { lock, variant: null, tag: lock?.tag ?? null }
  return { lock, variant: resolveVariant(id), tag: lock?.tag ?? lock?.variants?.[id]?.tag ?? null }
}
