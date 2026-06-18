/**
 * Which HuggingFace files belong together for one runnable Omega model.
 * Shared by main-process downloads and Model Studio UI.
 */
import type { HFFile } from './index.js'
import {
  effectiveFileSizeBytes,
  expandShardPaths,
  formatFileGiB,
  shardGroupKey
} from './hf-file-size.js'

const VISION_REPO_RE =
  /vision|vl-|llava|gemma-3|gemma-4|pixtral|qwen2\.?vl|qwen3\.6|qwen3\.5|minicpm-v|phi-3\.5-vision|moondream|bakllava/i

const MMPROJ_FILE_RE = /mmproj|clip|-vision/i

/** True for vision projector / clip sidecars — not runnable as the chat model. */
export function isMmprojGgufPath(pathOrName: string): boolean {
  const base = pathOrName.split(/[/\\]/).pop() ?? pathOrName
  return MMPROJ_FILE_RE.test(base)
}

export type ModelFileRole = 'chat' | 'vision' | 'shard' | 'other'

export function isVisionModelRepo(repoId: string, tags: string[] = []): boolean {
  const hay = `${repoId} ${tags.join(' ')}`.toLowerCase()
  return VISION_REPO_RE.test(hay) || tags.some((t) => /image-text-to-text|image-to-text/i.test(t))
}

export function fileRole(file: HFFile, repoId: string, tags: string[] = []): ModelFileRole {
  if (file.format === 'gguf') {
    if (MMPROJ_FILE_RE.test(file.path)) return 'vision'
    if (shardGroupKey(file.path)) return 'shard'
    return 'chat'
  }
  if (['safetensors', 'awq', 'gptq', 'pytorch'].includes(file.format)) return 'shard'
  return 'other'
}

/** One entry per chat GGUF variant (dedupe multi-part shards). */
function chatGgufVariants(files: HFFile[]): HFFile[] {
  const gguf = files.filter((f) => f.format === 'gguf' && !MMPROJ_FILE_RE.test(f.path))
  const seen = new Set<string>()
  const out: HFFile[] = []
  for (const f of gguf) {
    const key = shardGroupKey(f.path) ?? f.path
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Best default GGUF for chat (single file). */
export function pickPrimaryGgufFile(files: HFFile[]): HFFile | null {
  const gguf = chatGgufVariants(files)
  if (!gguf.length) return null
  const prefer = [/Q4_K_M/i, /Q5_K_M/i, /Q4_K_S/i, /Q4_0/i, /Q5_0/i]
  for (const re of prefer) {
    const hit = gguf.find((f) => re.test(f.path))
    if (hit) return hit
  }
  return gguf[0] ?? null
}

/** One vision projector file (not all mmproj variants). */
export function pickVisionProjectorFile(files: HFFile[], chatPath: string | null): HFFile | null {
  const mmprojs = files.filter(
    (f) => f.format === 'gguf' && f.path !== chatPath && MMPROJ_FILE_RE.test(f.path)
  )
  if (!mmprojs.length) return null
  const prefer = [/mmproj-F16/i, /mmproj-Q8/i, /mmproj-Q4/i, /mmproj-F32/i, /mmproj/i]
  for (const re of prefer) {
    const hit = mmprojs.find((f) => re.test(f.path))
    if (hit) return hit
  }
  return mmprojs[0] ?? null
}

/** Paths Omega needs for a ready-to-run GGUF install (sync; safetensors shards need extra HF files via main). */
export function resolveReadyGgufPaths(
  repoId: string,
  files: HFFile[],
  opts?: { chatPath?: string; visionPath?: string; tags?: string[] }
): string[] {
  const tags = opts?.tags ?? []
  const chat =
    opts?.chatPath && files.some((f) => f.path === opts.chatPath)
      ? files.find((f) => f.path === opts.chatPath)!
      : pickPrimaryGgufFile(files)
  if (!chat) return []
  const paths = expandShardPaths(files, chat.path)
  if (isVisionModelRepo(repoId, tags)) {
    const mm =
      opts?.visionPath && files.some((f) => f.path === opts.visionPath)
        ? files.find((f) => f.path === opts.visionPath)!
        : pickVisionProjectorFile(files, chat.path)
    if (mm) paths.push(...expandShardPaths(files, mm.path))
  }
  return paths
}

export function sumFileBytes(files: HFFile[], paths: string[]): number {
  const set = new Set(paths)
  let total = 0
  const seen = new Set<string>()
  for (const f of files) {
    if (!set.has(f.path)) continue
    const key = shardGroupKey(f.path)
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
      total += effectiveFileSizeBytes(f, files)
    } else {
      total += f.size
    }
  }
  return total
}

export type QuantPreset = {
  id: string
  label: string
  hint: string
  file: HFFile
}

/** A few chat quants to show as choices (not the full list). */
/** Mirrors localgen `downloads._MIN_WEIGHT_BYTES` — real weights, not LFS pointers. */
const MIN_SNAPSHOT_WEIGHT_BYTES = 100 * 1024 * 1024

const SNAPSHOT_INDEX_NAMES = new Set(['model_index.json'])
const SNAPSHOT_WEIGHT_NAMES = new Set([
  'diffusion_pytorch_model.safetensors',
  'diffusion_pytorch_model.bin',
  'model.safetensors',
  'pytorch_model.bin'
])
const SNAPSHOT_WEIGHT_SUFFIXES = ['.safetensors', '.ckpt']

const ONNX_GENAI_MARKER = 'genai_config.json'

const ONNX_GENAI_SUPPORT_NAMES = new Set([
  'genai_config.json',
  'config.json',
  'tokenizer.json',
  'tokenizer.model',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'chat_template.jinja',
  'added_tokens.json',
  'generation_config.json'
])

function hfFileBaseName(path: string): string {
  return (path.split(/[/\\]/).pop() ?? path).toLowerCase()
}

function hasGenaiConfigFile(files: HFFile[]): boolean {
  return files.some((f) => hfFileBaseName(f.path) === ONNX_GENAI_MARKER)
}

function hfFileDir(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(0, idx) : ''
}

function scoreGenaiPackPath(path: string): number {
  const lower = path.toLowerCase()
  let score = 0
  if (lower.includes('cpu')) score += 100
  if (lower.includes('int4')) score += 50
  if (lower.includes('mobile')) score += 25
  if (lower.includes('gpu') || lower.includes('cuda')) score -= 30
  score -= path.split('/').length
  return score
}

/** Pick one nested Microsoft-style genai_config variant (prefers CPU INT4). */
export function pickPrimaryGenaiConfigPath(files: HFFile[]): string | null {
  const paths = files
    .filter((f) => hfFileBaseName(f.path) === ONNX_GENAI_MARKER)
    .map((f) => f.path)
  if (!paths.length) return null
  if (paths.length === 1) return paths[0]!
  return [...paths].sort((a, b) => scoreGenaiPackPath(b) - scoreGenaiPackPath(a))[0] ?? null
}

function isOnnxWeightPath(path: string): boolean {
  return /\.onnx(?:[._]data(?:_\d+)?)?$/i.test(path) || /\/[^/]+\.onnx$/i.test(path)
}

function hasOnnxChatWeights(files: HFFile[]): boolean {
  return files.some((f) => f.format === 'onnx' || isOnnxWeightPath(f.path))
}

const CS_TTS_SIGNAL =
  /text-to-speech|text-to-audio|speech-synthesis|\btts\b|voice-cloning|vocoder|speecht5/i
const CS_IMAGE_SIGNAL =
  /text-to-image|image-to-image|stable-diffusion|\bdiffusion\b|flux|sdxl|controlnet/i
const CS_VIDEO_SIGNAL =
  /text-to-video|image-to-video|video-generation|\bt2v\b|\bi2v\b|ltx-video|hunyuanvideo|cogvideox|wan2\.1|mochi/i

const ONNX_CHAT_PIPELINES = new Set(['text-generation', 'text2text-generation'])
const ONNX_NON_CHAT_PIPELINES = new Set([
  'text-to-speech',
  'automatic-speech-recognition',
  'feature-extraction',
  'sentence-similarity',
  'image-classification',
  'object-detection',
  'depth-estimation',
  'image-to-text',
  'image-text-to-text',
  'visual-question-answering',
  'token-classification',
  'text-classification',
  'fill-mask',
  'any-to-any',
  'image-feature-extraction',
  'audio-classification',
  'text-to-image',
  'image-to-image',
  'text-to-video',
  'image-to-video',
  'zero-shot-image-classification',
  'zero-shot-object-detection'
])

function normalizePipeline(pipeline?: string): string {
  return (pipeline ?? '').trim().toLowerCase()
}

function repoHaystack(repoId: string, tags: string[], pipeline?: string): string {
  return `${repoId} ${tags.join(' ')} ${pipeline ?? ''}`.toLowerCase()
}

function hasTokenizerFiles(files: HFFile[]): boolean {
  return files.some((f) =>
    ['tokenizer.json', 'tokenizer.model'].includes(hfFileBaseName(f.path))
  )
}

const VISION_ONNX_REPO_RE =
  /dinov|siglip|clip-vit|\/vit-|\/vit_|yolo|detr|sam-|paddleocr|texteller|ocr|depth-anything|segment|pretrain-lvd|image-feature-extraction/i

const EMBEDDING_ONNX_REPO_RE =
  /embedding|embed-|minilm|e5-|bge-|reranker|sentence-transformer|gte-|nomic-embed|paraphrase-/i

const SPEECH_ONNX_REPO_RE =
  /whisper|kokoro|moonshine|transcribe|tts|asr|speech|style_text_to_speech|parler|chatterbox|xtts|bark/i

const MULTIMODAL_ONNX_REPO_RE = /florence|gemma-4|gemma4|pixtral|llava|qwen2\.?5-vl|qwen3-vl|phi-3\.5-vision|phi-4-multimodal|moondream|image-text-to-text/i

export type OnnxRepoKind =
  | 'chat'
  | 'vision_encoder'
  | 'embedding'
  | 'speech'
  | 'multimodal'
  | 'utility'
  | 'unknown'

function isTextOnnxRepoSignal(repoId: string, tags: string[], pipeline?: string): boolean {
  const hay = repoHaystack(repoId, tags, pipeline)
  const p = normalizePipeline(pipeline)
  if (p && ONNX_CHAT_PIPELINES.has(p)) return true
  if (/text-generation|conversational|causal-lm|text2text|chat-model|\bllm\b/i.test(hay)) return true
  if (/onnx-community|text-onnx|-text-|\/text-/i.test(hay)) return true
  if (/\btext\b.*\bonnx\b|\bonnx\b.*\btext\b/i.test(hay)) return true
  if (/-onnx$|-instruct-onnx|instruct-onnx/i.test(repoId)) return true
  if (
    /\b(smollm|phi-?\d|qwen|gemma|llama|mistral|granite|nemotron|gpt-oss|falcon|olmo|deepseek|lfm2|bonsai|pythia|arcee)\b/i.test(
      hay
    )
  ) {
    return true
  }
  if (tags.some((t) => /text-generation|conversational|causal-lm/i.test(t))) return true
  return false
}

function isOnnxNonChatPipeline(pipeline?: string, tags: string[] = []): boolean {
  const p = normalizePipeline(pipeline)
  if (p && ONNX_NON_CHAT_PIPELINES.has(p)) return true
  return tags.some((t) => ONNX_NON_CHAT_PIPELINES.has(t.toLowerCase()))
}

/** ONNX vision encoder (DINOv, SigLIP) — not chat. */
export function isOnnxVisionEncoderRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!hasOnnxChatWeights(files)) return false
  if (hasGenaiConfigFile(files)) return false

  const p = normalizePipeline(pipeline)
  if (p === 'image-feature-extraction' || p === 'image-classification' || p === 'depth-estimation') {
    return true
  }

  const hay = repoHaystack(repoId ?? '', tags, pipeline)
  if (VISION_ONNX_REPO_RE.test(hay)) return true
  if (
    files.some((f) => hfFileBaseName(f.path) === 'preprocessor_config.json') &&
    !hasTokenizerFiles(files)
  ) {
    return true
  }
  return false
}

/** ONNX embedding / reranker — not chat (Qwen3-Embedding, MiniLM, BGE). */
export function isOnnxEmbeddingRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!hasOnnxChatWeights(files)) return false
  if (hasGenaiConfigFile(files)) return false

  const p = normalizePipeline(pipeline)
  if (p === 'feature-extraction' || p === 'sentence-similarity' || p === 'text-classification') {
    return true
  }

  const hay = repoHaystack(repoId ?? '', tags, pipeline)
  if (EMBEDDING_ONNX_REPO_RE.test(hay)) return true
  if (tags.some((t) => ['feature-extraction', 'sentence-similarity', 'text-embeddings-inference'].includes(t.toLowerCase())))
    return true
  return false
}

/** ONNX TTS / ASR — Content Studio audio, not chat. */
export function isOnnxSpeechRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!hasOnnxChatWeights(files)) return false
  const p = normalizePipeline(pipeline)
  if (p === 'text-to-speech' || p === 'automatic-speech-recognition' || p === 'audio-to-audio') {
    return true
  }
  const hay = repoHaystack(repoId ?? '', tags, pipeline)
  return SPEECH_ONNX_REPO_RE.test(hay) || CS_TTS_SIGNAL.test(hay)
}

/** ONNX multimodal (Florence-2, Gemma 4) — not sidecar text chat yet. */
export function isOnnxMultimodalRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!hasOnnxChatWeights(files)) return false
  if (hasGenaiConfigFile(files) && normalizePipeline(pipeline) === 'text-generation') return false

  const p = normalizePipeline(pipeline)
  if (
    p === 'image-text-to-text' ||
    p === 'any-to-any' ||
    p === 'visual-question-answering' ||
    p === 'image-to-text'
  ) {
    return true
  }

  const hay = repoHaystack(repoId ?? '', tags, pipeline)
  if (MULTIMODAL_ONNX_REPO_RE.test(hay)) return true
  if (tags.some((t) => ['image-text-to-text', 'any-to-any', 'image-to-text'].includes(t.toLowerCase())))
    return true
  return false
}

/** Other ONNX task models (depth, token-classification, etc.). */
export function isOnnxUtilityRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!hasOnnxChatWeights(files)) return false
  if (
    isOnnxVisionEncoderRepo(files, tags, pipeline, repoId) ||
    isOnnxEmbeddingRepo(files, tags, pipeline, repoId) ||
    isOnnxSpeechRepo(files, tags, pipeline, repoId) ||
    isOnnxMultimodalRepo(files, tags, pipeline, repoId)
  ) {
    return false
  }
  return isOnnxNonChatPipeline(pipeline, tags)
}

/** Classify an ONNX repo using HF pipeline tags + file layout (from HF API research). */
export function inferOnnxRepoKind(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): OnnxRepoKind | null {
  if (!hasOnnxChatWeights(files)) return null
  if (isOnnxGenaiChatRepo(files, tags, pipeline, repoId)) return 'chat'
  if (isOnnxEmbeddingRepo(files, tags, pipeline, repoId)) return 'embedding'
  if (isOnnxSpeechRepo(files, tags, pipeline, repoId)) return 'speech'
  if (isOnnxMultimodalRepo(files, tags, pipeline, repoId)) return 'multimodal'
  if (isOnnxVisionEncoderRepo(files, tags, pipeline, repoId)) return 'vision_encoder'
  if (isOnnxUtilityRepo(files, tags, pipeline, repoId)) return 'utility'
  return 'unknown'
}

function isGenerationRepoSignal(tags: string[], pipeline?: string, repoId?: string): boolean {
  const hay = repoHaystack(repoId ?? '', tags, pipeline)
  const p = normalizePipeline(pipeline)
  if (p === 'text-to-speech' || p === 'text-to-image' || p === 'text-to-video' || p === 'image-to-video')
    return true
  return (
    CS_TTS_SIGNAL.test(hay) ||
    CS_IMAGE_SIGNAL.test(hay) ||
    CS_VIDEO_SIGNAL.test(hay)
  )
}

/** Best default ONNX chat weights (one variant — excludes .onnx_data sidecars). */
export function pickPrimaryOnnxFile(
  files: HFFile[],
  opts?: { genaiConfigPath?: string | null }
): HFFile | null {
  let onnx = files.filter(
    (f) => (f.format === 'onnx' || /\.onnx$/i.test(f.path)) && !/\.onnx[._]data/i.test(f.path)
  )
  if (!onnx.length) return null

  const packDir = opts?.genaiConfigPath ? hfFileDir(opts.genaiConfigPath) : ''
  if (packDir) {
    const inPack = onnx.filter((f) => {
      const dir = hfFileDir(f.path)
      return dir === packDir || f.path.startsWith(`${packDir}/`)
    })
    if (inPack.length) onnx = inPack
  }

  const prefer = [
    /model_q4f16\.onnx$/i,
    /model_q4\.onnx$/i,
    /model_quantized\.onnx$/i,
    /model_fp16\.onnx$/i,
    /model\.onnx$/i,
    /-int4-.*\.onnx$/i,
    /phi-.*\.onnx$/i
  ]
  for (const re of prefer) {
    const hit = onnx.find((f) => re.test(f.path.split('/').pop() ?? f.path))
    if (hit) return hit
  }
  return onnx.sort((a, b) => a.size - b.size)[0] ?? null
}

function onnxDataPathsForPrimary(files: HFFile[], primaryPath: string): string[] {
  const stem = primaryPath.replace(/\.onnx$/i, '')
  return files
    .filter(
      (f) =>
        f.path !== primaryPath &&
        /\.onnx[._]data/i.test(f.path) &&
        f.path.startsWith(stem)
    )
    .map((f) => f.path)
}

/** True when the HF repo is an ONNX Runtime GenAI chat pack (not diffusion/TTS weights). */
export function isOnnxGenaiChatRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!hasOnnxChatWeights(files)) return false
  if (isOnnxEmbeddingRepo(files, tags, pipeline, repoId)) return false
  if (isOnnxSpeechRepo(files, tags, pipeline, repoId)) return false
  if (isOnnxMultimodalRepo(files, tags, pipeline, repoId)) return false
  if (isOnnxVisionEncoderRepo(files, tags, pipeline, repoId)) return false
  if (isOnnxUtilityRepo(files, tags, pipeline, repoId)) return false
  if (isGenerationRepoSignal(tags, pipeline, repoId)) return false

  if (hasGenaiConfigFile(files)) return true

  const hasConfig = files.some((f) => hfFileBaseName(f.path) === 'config.json')
  const hasTokenizer = hasTokenizerFiles(files)
  if (!hasConfig || !hasTokenizer) return false

  const p = normalizePipeline(pipeline)
  if (p && ONNX_NON_CHAT_PIPELINES.has(p)) return false
  if (p && ONNX_CHAT_PIPELINES.has(p)) return true

  return isTextOnnxRepoSignal(repoId ?? '', tags, pipeline)
}

/** Paths needed for a runnable ONNX GenAI chat install under ~/.omega/models/<repo-leaf>/. */
export function resolveOnnxGenaiPaths(
  files: HFFile[],
  opts?: { onnxPath?: string }
): string[] {
  if (!hasOnnxChatWeights(files) && !hasGenaiConfigFile(files)) return []

  const genaiConfigPath = pickPrimaryGenaiConfigPath(files)
  const packDir = genaiConfigPath ? hfFileDir(genaiConfigPath) : ''

  const primary =
    opts?.onnxPath && files.some((f) => f.path === opts.onnxPath)
      ? files.find((f) => f.path === opts.onnxPath)!
      : pickPrimaryOnnxFile(files, { genaiConfigPath })

  const paths: string[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }

  if (genaiConfigPath) add(genaiConfigPath)

  if (primary) {
    add(primary.path)
    for (const dataPath of onnxDataPathsForPrimary(files, primary.path)) add(dataPath)
  } else if (genaiConfigPath) {
    for (const f of files) {
      if (f.format === 'onnx' || isOnnxWeightPath(f.path)) add(f.path)
    }
  } else {
    return []
  }

  for (const f of files) {
    const base = hfFileBaseName(f.path)
    if (!ONNX_GENAI_SUPPORT_NAMES.has(base)) continue
    if (packDir) {
      const dir = hfFileDir(f.path)
      if (dir !== packDir && dir !== '') continue
    }
    add(f.path)
  }

  return paths
}

function isSnapshotWeightEntry(file: HFFile): boolean {
  const base = hfFileBaseName(file.path)
  if (SNAPSHOT_INDEX_NAMES.has(base)) return true
  if (SNAPSHOT_WEIGHT_NAMES.has(base)) return file.size >= MIN_SNAPSHOT_WEIGHT_BYTES
  const dot = file.path.lastIndexOf('.')
  if (dot < 0) return false
  const suffix = file.path.slice(dot).toLowerCase()
  if (!SNAPSHOT_WEIGHT_SUFFIXES.includes(suffix)) return false
  return file.size >= MIN_SNAPSHOT_WEIGHT_BYTES
}

export type ContentStudioKind = 'tts' | 'image' | 'video'

/** True when the HF file list looks like a full Content Studio snapshot (TTS / image), not GGUF chat. */
export function isContentStudioSnapshotRepo(
  files: HFFile[],
  tags: string[] = [],
  pipeline?: string,
  repoId?: string
): boolean {
  if (!files.length) return false
  if (isOnnxGenaiChatRepo(files, tags, pipeline, repoId)) return false

  const onnxKind = inferOnnxRepoKind(files, tags, pipeline, repoId)
  if (onnxKind && onnxKind !== 'chat' && onnxKind !== 'unknown') return true

  if (files.some(isSnapshotWeightEntry)) return true
  const hay = `${tags.join(' ')} ${pipeline ?? ''}`.toLowerCase()
  if (!CS_TTS_SIGNAL.test(hay) && !CS_IMAGE_SIGNAL.test(hay) && !CS_VIDEO_SIGNAL.test(hay))
    return false
  return files.some(
    (f) =>
      ['safetensors', 'pytorch', 'bin', 'awq', 'gptq'].includes(f.format) &&
      f.size >= MIN_SNAPSHOT_WEIGHT_BYTES
  )
}

/** Best guess for which generation-models folder should receive the snapshot. */
export function inferContentStudioKind(
  repoId: string,
  tags: string[] = [],
  pipeline?: string
): ContentStudioKind {
  const p = normalizePipeline(pipeline)
  if (p === 'text-to-speech' || p === 'automatic-speech-recognition' || p === 'audio-to-audio') return 'tts'
  if (p === 'text-to-image' || p === 'image-to-image') return 'image'
  if (p === 'text-to-video' || p === 'image-to-video') return 'video'

  const hay = `${repoId} ${tags.join(' ')} ${pipeline ?? ''}`
  let ttsScore = CS_TTS_SIGNAL.test(hay) ? 2 : 0
  let imgScore = CS_IMAGE_SIGNAL.test(hay) ? 2 : 0
  let videoScore = CS_VIDEO_SIGNAL.test(hay) ? 2 : 0
  if (/tts|qwen3-tts|chatterbox|bark|xtts|speech|voice|vocoder/i.test(repoId)) ttsScore += 2
  if (/sdxl|stable-diffusion|flux|interdiffusion|z-image|sd3/i.test(repoId)) imgScore += 2
  if (/ltx-video|hunyuanvideo|cogvideo|wan2\.1|mochi|t2v|i2v/i.test(repoId)) videoScore += 2
  if (/\bdiffusers\b/i.test(hay) && /video/i.test(hay)) videoScore += 1

  const best = Math.max(ttsScore, imgScore, videoScore)
  if (best > 0) {
    if (videoScore === best) return 'video'
    if (ttsScore === best) return 'tts'
    if (imgScore === best) return 'image'
  }
  if (/tts|speech|voice|audio|vocoder/i.test(repoId)) return 'tts'
  if (/video|t2v|i2v|ltx/i.test(repoId)) return 'video'
  return 'image'
}

/** Upper-bound size for a full HF snapshot (sum of listed files). */
export function estimateContentStudioSnapshotBytes(files: HFFile[]): number {
  return files.reduce((acc, f) => acc + f.size, 0)
}

export function chatQuantPresets(files: HFFile[], max = 6): QuantPreset[] {
  const gguf = chatGgufVariants(files).sort(
    (a, b) => effectiveFileSizeBytes(a, files) - effectiveFileSizeBytes(b, files)
  )
  const order = [
    { id: 'recommended', re: /Q4_K_M/i, label: 'Recommended', hint: 'Best balance of quality and size' },
    { id: 'fast', re: /Q4_K_S|Q4_0/i, label: 'Faster / smaller', hint: 'Slightly smaller, still strong' },
    { id: 'quality', re: /Q5_K_M|Q6_K/i, label: 'Higher quality', hint: 'Larger download, better output' },
    { id: 'compact', re: /IQ4|Q3_K_M/i, label: 'Compact', hint: 'Smallest practical quants' }
  ]
  const used = new Set<string>()
  const out: QuantPreset[] = []
  for (const slot of order) {
    const hit = gguf.find((f) => slot.re.test(f.path) && !used.has(f.path))
    if (hit) {
      used.add(hit.path)
      out.push({ id: slot.id, label: slot.label, hint: slot.hint, file: hit })
    }
  }
  for (const f of gguf) {
    if (out.length >= max) break
    if (used.has(f.path)) continue
    used.add(f.path)
    out.push({
      id: f.path,
      label: f.quant ?? f.path.split('/').pop() ?? 'Variant',
      hint: `${formatFileGiB(effectiveFileSizeBytes(f, files), 1)} on disk`,
      file: f
    })
  }
  return out
}
