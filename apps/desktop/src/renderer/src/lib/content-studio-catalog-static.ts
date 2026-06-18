import type { ContentGenerationModelEntry } from '@omega/sdk'

/** Instant suggested models for Settings → Omega tools (no IPC). */
export const STATIC_SUGGESTED_TTS: ContentGenerationModelEntry[] = [
  {
    key: 'Qwen3-TTS-12Hz-0.6B-CustomVoice',
    repo_id: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    description: 'Smaller Custom Voice model (faster, lower quality)',
    size: '~1.5 GB'
  }
]

export const STATIC_SUGGESTED_IMAGE: ContentGenerationModelEntry[] = [
  {
    key: 'InterDiffusion-Nano',
    repo_id: 'cutycat2000/InterDiffusion-Nano',
    description:
      'Compact SD 1.5 text-to-image — single-file checkpoint. Fast, low VRAM (~2 GB).',
    size: '~2.0 GB',
    default_num_steps: 25,
    default_width: 512,
    default_height: 512
  }
]

export const STATIC_SUGGESTED_VIDEO: ContentGenerationModelEntry[] = [
  {
    key: 'LTX-Video-0.9.5',
    repo_id: 'Lightricks/LTX-Video-0.9.5',
    description: 'Lightricks LTX-Video text-to-video (diffusers)',
    size: '~8 GB',
    default_num_frames: 97,
    default_num_steps: 30,
    default_fps: 24,
    default_width: 704,
    default_height: 480
  }
]
