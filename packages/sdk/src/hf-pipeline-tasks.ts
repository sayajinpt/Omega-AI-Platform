/**
 * Hugging Face Hub pipeline_tag values (official model tasks).
 * @see https://huggingface.co/models — Tasks filter
 */

export type HfPipelineTask = {
  id: string
  label: string
  /** When set, Browse HF defaults to this weight format unless the user overrides. */
  suggestedFormat?: 'gguf' | 'any'
}

/** Curated list matching the HF Hub task filter (most-used tasks first). */
export const HF_PIPELINE_TASKS: HfPipelineTask[] = [
  { id: 'text-generation', label: 'Text Generation', suggestedFormat: 'gguf' },
  { id: 'image-text-to-text', label: 'Image-Text-to-Text', suggestedFormat: 'any' },
  { id: 'any-to-any', label: 'Any-to-Any', suggestedFormat: 'any' },
  { id: 'text-to-image', label: 'Text-to-Image', suggestedFormat: 'any' },
  { id: 'text-to-video', label: 'Text-to-Video', suggestedFormat: 'any' },
  { id: 'image-to-video', label: 'Image-to-Video', suggestedFormat: 'any' },
  { id: 'image-to-image', label: 'Image-to-Image', suggestedFormat: 'any' },
  { id: 'image-to-text', label: 'Image-to-Text', suggestedFormat: 'any' },
  { id: 'text-to-speech', label: 'Text-to-Speech', suggestedFormat: 'any' },
  { id: 'automatic-speech-recognition', label: 'Speech-to-Text', suggestedFormat: 'any' },
  { id: 'feature-extraction', label: 'Feature Extraction', suggestedFormat: 'any' },
  { id: 'sentence-similarity', label: 'Sentence Similarity', suggestedFormat: 'any' },
  { id: 'text-classification', label: 'Text Classification', suggestedFormat: 'any' },
  { id: 'token-classification', label: 'Token Classification', suggestedFormat: 'any' },
  { id: 'fill-mask', label: 'Fill-Mask', suggestedFormat: 'any' },
  { id: 'summarization', label: 'Summarization', suggestedFormat: 'any' },
  { id: 'translation', label: 'Translation', suggestedFormat: 'any' },
  { id: 'conversational', label: 'Conversational', suggestedFormat: 'gguf' },
  { id: 'visual-question-answering', label: 'Visual QA', suggestedFormat: 'any' },
  { id: 'image-classification', label: 'Image Classification', suggestedFormat: 'any' },
  { id: 'image-feature-extraction', label: 'Image Feature Extraction', suggestedFormat: 'any' },
  { id: 'object-detection', label: 'Object Detection', suggestedFormat: 'any' },
  { id: 'depth-estimation', label: 'Depth Estimation', suggestedFormat: 'any' },
  { id: 'text-to-audio', label: 'Text-to-Audio', suggestedFormat: 'any' },
  { id: 'audio-to-audio', label: 'Audio-to-Audio', suggestedFormat: 'any' },
  { id: 'audio-classification', label: 'Audio Classification', suggestedFormat: 'any' },
  { id: 'video-classification', label: 'Video Classification', suggestedFormat: 'any' },
  { id: 'reinforcement-learning', label: 'Reinforcement Learning', suggestedFormat: 'any' },
  { id: 'robotics', label: 'Robotics', suggestedFormat: 'any' }
]

const TASK_BY_ID = new Map(HF_PIPELINE_TASKS.map((t) => [t.id, t]))

export function normalizePipelineTag(pipeline?: string): string {
  return (pipeline ?? '').trim().toLowerCase()
}

export function formatPipelineLabel(pipeline?: string): string {
  const id = normalizePipelineTag(pipeline)
  if (!id) return ''
  const hit = TASK_BY_ID.get(id)
  if (hit) return hit.label
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-')
}

/** Generation / diffusion tasks — GGUF filter hides these on HF. */
export function pipelinePrefersAnyFormat(pipeline?: string): boolean {
  const id = normalizePipelineTag(pipeline)
  if (!id) return false
  const task = TASK_BY_ID.get(id)
  if (task?.suggestedFormat === 'any') return true
  return (
    id.includes('video') ||
    id.includes('image') ||
    id.includes('speech') ||
    id.includes('audio') ||
    id === 'any-to-any' ||
    id === 'feature-extraction' ||
    id === 'sentence-similarity'
  )
}

export function resolvePipelineFromTags(tags: string[] = [], pipeline?: string): string {
  const p = normalizePipelineTag(pipeline)
  if (p) return p
  for (const t of tags) {
    const lower = t.toLowerCase()
    if (TASK_BY_ID.has(lower)) return lower
  }
  return ''
}
