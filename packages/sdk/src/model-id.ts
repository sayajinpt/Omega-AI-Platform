/** Ollama registry id like `llama3:8b` (not a file path). */
export function isOllamaRegistryId(id: string): boolean {
  return /^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(id) && !id.includes('/')
}

const WEIGHT_EXT = /\.(gguf|safetensors|onnx|exl2|bin|pt|pth|npz)$/i

export function hasWeightExtension(id: string): boolean {
  return WEIGHT_EXT.test(id.toLowerCase())
}

/**
 * Cloud API model id: `<providerId>/<upstream-model>` (provider id has no slashes).
 */
export function isProviderQualifiedModelId(id: string): boolean {
  if (!id || !id.includes('/') || id.startsWith('ollama:')) return false
  if (hasWeightExtension(id)) return false
  const slash = id.indexOf('/')
  const providerId = id.slice(0, slash)
  if (!providerId || providerId.includes('/') || providerId.includes('.')) return false
  const model = id.slice(slash + 1)
  return model.length > 0
}

/** @deprecated Use isProviderQualifiedModelId */
export function isRemoteModelId(id: string): boolean {
  return isProviderQualifiedModelId(id)
}

/** Any on-disk model (not remote API or bare Ollama library tag). */
export function isLocalModelId(id: string): boolean {
  if (!id || id.startsWith('ollama:')) return false
  if (isOllamaRegistryId(id)) return false
  if (isProviderQualifiedModelId(id)) return false
  return true
}

/** Local GGUF file id. */
export function isLocalGgufModelId(id: string): boolean {
  return isLocalModelId(id) && id.toLowerCase().endsWith('.gguf')
}

function stripGguf(id: string): string {
  return id.replace(/\.gguf$/i, '')
}

/** HF / Model Studio pack folder (not a bare GGUF filename stem). */
function looksLikePackFolderId(id: string): boolean {
  return /-gguf$/i.test(id) || id.includes('__')
}

/** Bare GGUF filename stem missing the `.gguf` suffix (e.g. `Llama-3-8B-Q4_K_M`). */
function looksLikeBareGgufStem(id: string): boolean {
  if (hasWeightExtension(id) || looksLikePackFolderId(id)) return false
  return /(?:^|[._-])(?:iq\d|q\d[\d_kms.]*|f16|f32|bf16)/i.test(id)
}

/** Canonical id for a local model. */
export function normalizeModelId(id: string): string {
  if (!id) return id
  if (id.startsWith('ollama:')) return id
  if (isProviderQualifiedModelId(id)) return id
  if (isOllamaRegistryId(id)) return id
  if (hasWeightExtension(id)) return id
  if (looksLikeBareGgufStem(id)) return `${id}.gguf`
  return id
}

export function modelIdsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  if (normalizeModelId(a) === normalizeModelId(b)) return true
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  if (al.endsWith('.gguf') || bl.endsWith('.gguf')) {
    return stripGguf(a) === stripGguf(b) || stripGguf(normalizeModelId(a)) === stripGguf(normalizeModelId(b))
  }
  return false
}

/** omega-runtime registry id (filename stem, no `.gguf` extension). */
export function runtimeModelId(id: string): string {
  if (!id) return id
  if (isProviderQualifiedModelId(id) || id.startsWith('ollama:') || isOllamaRegistryId(id)) return id
  if (id.toLowerCase().endsWith('.gguf')) return stripGguf(id)
  return id
}
