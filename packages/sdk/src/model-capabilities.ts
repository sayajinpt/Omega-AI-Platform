/** Capability chips inferred from HF tags, names, and catalog metadata (pre-download). */

export type ModelCapabilityId =
  | 'chat'
  | 'vision'
  | 'tools'
  | 'reasoning'
  | 'code'
  | 'embedding'
  | 'audio'
  | 'moe'
  | 'long-context'

export interface ModelCapability {
  id: ModelCapabilityId
  label: string
  title: string
  icon: string
  tone: string
}

const CAP_DEFS: Record<ModelCapabilityId, Omit<ModelCapability, 'id'>> = {
  chat: {
    label: 'Chat',
    title: 'General instruction / chat',
    icon: '💬',
    tone: 'bg-zinc-800/90 text-zinc-300 ring-zinc-600/50'
  },
  vision: {
    label: 'Vision',
    title: 'Image / multimodal input',
    icon: '👁',
    tone: 'bg-violet-900/50 text-violet-200 ring-violet-600/40'
  },
  tools: {
    label: 'Tools',
    title: 'Function calling & agentic tool use',
    icon: '🔧',
    tone: 'bg-cyan-900/50 text-cyan-200 ring-cyan-600/40'
  },
  reasoning: {
    label: 'Reason',
    title: 'Chain-of-thought / reasoning tuned',
    icon: '🧠',
    tone: 'bg-amber-900/50 text-amber-200 ring-amber-600/40'
  },
  code: {
    label: 'Code',
    title: 'Coding / software engineering',
    icon: '💻',
    tone: 'bg-emerald-900/50 text-emerald-200 ring-emerald-600/40'
  },
  embedding: {
    label: 'Embed',
    title: 'Embeddings / retrieval',
    icon: '📐',
    tone: 'bg-slate-800/90 text-slate-300 ring-slate-600/50'
  },
  audio: {
    label: 'Audio',
    title: 'Audio input or speech',
    icon: '🔊',
    tone: 'bg-pink-900/50 text-pink-200 ring-pink-600/40'
  },
  moe: {
    label: 'MoE',
    title: 'Mixture-of-experts architecture',
    icon: '⚡',
    tone: 'bg-indigo-900/50 text-indigo-200 ring-indigo-600/40'
  },
  'long-context': {
    label: 'Long ctx',
    title: 'Extended context window (32k+)',
    icon: '📜',
    tone: 'bg-sky-900/50 text-sky-200 ring-sky-600/40'
  }
}

export type ModelCapabilityInput = {
  name?: string
  description?: string
  tags?: string[]
  category?: string
  pipeline?: string
  readme?: string
  params?: string
}

function hay(input: ModelCapabilityInput): string {
  const parts = [
    input.name,
    input.description,
    input.params,
    input.category,
    input.pipeline,
    input.readme?.slice(0, 4000),
    ...(input.tags ?? [])
  ]
  return parts.filter(Boolean).join(' ').toLowerCase()
}

function has(h: string, ...needles: string[]): boolean {
  return needles.some((n) => h.includes(n))
}

/** Infer capabilities from public metadata (works before download). */
export function inferModelCapabilities(input: ModelCapabilityInput): ModelCapability[] {
  const h = hay(input)
  const tags = (input.tags ?? []).map((t) => t.toLowerCase())
  const pipeline = (input.pipeline ?? '').trim().toLowerCase()
  const found = new Set<ModelCapabilityId>()

  if (
    pipeline === 'feature-extraction' ||
    pipeline === 'sentence-similarity' ||
    /embedding|embed-|minilm|bge-|e5-|reranker|sentence-transformer/i.test(h)
  ) {
    found.add('embedding')
  }

  if (
    pipeline === 'text-to-speech' ||
    pipeline === 'automatic-speech-recognition' ||
    /whisper|kokoro|tts|asr|speech|transcribe|moonshine/i.test(h)
  ) {
    found.add('audio')
  }

  if (
    has(h, 'vision', 'multimodal', 'vl-', '-vl', 'llava', 'image-text', 'image_text', 'pixtral', 'moondream') ||
    has(h, 'dinov', 'dinov2', 'dinov3', 'siglip', 'clip-vit', 'pretrain-lvd', 'florence') ||
    pipeline === 'image-feature-extraction' ||
    pipeline === 'image-classification' ||
    pipeline === 'image-text-to-text' ||
    pipeline === 'visual-question-answering' ||
    pipeline === 'any-to-any' ||
    tags.some((t) => ['image-text-to-text', 'image-to-text', 'visual-question-answering'].includes(t)) ||
    input.category === 'vision'
  ) {
    found.add('vision')
  }

  if (
    has(
      h,
      'function-calling',
      'function calling',
      'tool-use',
      'tool use',
      'hermes',
      'agentic',
      'agent',
      'devstral',
      'tools'
    ) ||
    input.category === 'tools' ||
    tags.includes('function-calling')
  ) {
    found.add('tools')
  }

  if (
    has(h, 'reasoning', 'chain-of-thought', 'chain of thought', ' r1', 'r1-', 'o1', 'think', 'magistral') ||
    input.category === 'reasoning' ||
    tags.includes('reasoning')
  ) {
    found.add('reasoning')
  }

  if (
    has(h, 'coder', 'code', 'coding', 'starcoder', 'codellama', 'deepseek-coder', 'qwen2.5-coder', 'devstral') ||
    input.category === 'coder' ||
    tags.includes('code')
  ) {
    found.add('code')
  }

  if (
    has(h, 'embedding', 'embed', 'nomic-embed', 'bge-', 'e5-', 'gte-') ||
    input.category === 'embedding' ||
    tags.some((t) => t.includes('embedding') || t === 'feature-extraction')
  ) {
    found.add('embedding')
  }

  if (has(h, 'audio', 'speech', 'whisper', 'parler')) found.add('audio')

  if (has(h, 'moe', '-a3b', '-a22b', '-a4b', '-16e', '-128e', 'mixture')) found.add('moe')

  if (
    has(h, '128k', '256k', '1m', '10m', 'long-context', 'long context', '32k', '64k', '200k') ||
    tags.includes('long-context')
  ) {
    found.add('long-context')
  }

  if (found.has('embedding')) found.delete('chat')
  else if (found.has('vision') && !has(h, 'text-generation', 'instruct', 'conversational', 'chat')) {
    /* vision-only ONNX encoders — no default Chat chip */
  } else if (
    pipeline &&
    [
      'text-to-speech',
      'automatic-speech-recognition',
      'feature-extraction',
      'sentence-similarity',
      'image-feature-extraction',
      'depth-estimation',
      'token-classification'
    ].includes(pipeline)
  ) {
    /* pipeline-defined task — no default Chat chip */
  } else if (found.size === 0 || (!found.has('vision') && !found.has('tools') && !found.has('reasoning'))) {
    found.add('chat')
  }

  const order: ModelCapabilityId[] = [
    'vision',
    'tools',
    'reasoning',
    'code',
    'embedding',
    'audio',
    'moe',
    'long-context',
    'chat'
  ]

  return order.filter((id) => found.has(id)).map((id) => ({ id, ...CAP_DEFS[id] }))
}
