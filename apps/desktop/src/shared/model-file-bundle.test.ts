import { describe, expect, it } from 'vitest'
import type { HFFile } from '@omega/sdk'
import {
  inferContentStudioKind,
  inferOnnxRepoKind,
  isContentStudioSnapshotRepo,
  isOnnxGenaiChatRepo,
  isOnnxVisionEncoderRepo,
  pickVisionProjectorFile,
  resolveOnnxGenaiPaths,
  resolveReadyGgufPaths
} from './model-file-bundle'

function gguf(path: string, size = 1e9): HFFile {
  return { path, size, format: 'gguf', nativeSupported: true, quant: path.match(/Q4_K_M/)?.[0] }
}

describe('resolveReadyGgufPaths', () => {
  it('picks one chat gguf and one mmproj for vision repos', () => {
    const files = [
      gguf('mmproj-F16.gguf', 9e8),
      gguf('mmproj-F32.gguf', 18e8),
      gguf('Qwen3.6-27B-Q4_K_M.gguf', 16e9),
      gguf('Qwen3.6-27B-Q8_0.gguf', 27e9)
    ]
    const paths = resolveReadyGgufPaths('unsloth/Qwen3.6-27B-MTP-GGUF', files, {
      tags: ['image-text-to-text']
    })
    expect(paths).toHaveLength(2)
    expect(paths[0]).toBe('Qwen3.6-27B-Q4_K_M.gguf')
    expect(paths[1]).toBe('mmproj-F16.gguf')
  })

  it('respects explicit vision choice', () => {
    const files = [gguf('mmproj-F16.gguf'), gguf('mmproj-BF16.gguf'), gguf('model-Q4_K_M.gguf')]
    const paths = resolveReadyGgufPaths('repo', files, {
      chatPath: 'model-Q4_K_M.gguf',
      visionPath: 'mmproj-BF16.gguf',
      tags: ['vision']
    })
    expect(paths).toEqual(['model-Q4_K_M.gguf', 'mmproj-BF16.gguf'])
  })
})

describe('pickVisionProjectorFile', () => {
  it('prefers F16 over F32', () => {
    const files = [gguf('mmproj-F32.gguf'), gguf('mmproj-F16.gguf')]
    expect(pickVisionProjectorFile(files, 'x.gguf')?.path).toBe('mmproj-F16.gguf')
  })
})

function safetensors(path: string, size = 2e9): HFFile {
  return { path, size, format: 'safetensors', nativeSupported: false }
}

describe('isContentStudioSnapshotRepo', () => {
  it('detects InterDiffusion-style single model.safetensors repos', () => {
    const files = [safetensors('model.safetensors', 1.99e9)]
    expect(isContentStudioSnapshotRepo(files, [])).toBe(true)
  })

  it('rejects tiny safetensors pointer files', () => {
    const files = [safetensors('model.safetensors', 1024)]
    expect(isContentStudioSnapshotRepo(files, [])).toBe(false)
  })

  it('does not treat ONNX GenAI chat repos as Content Studio snapshots', () => {
    const files = [
      { path: 'genai_config.json', size: 4096, format: 'config' as const, nativeSupported: false },
      { path: 'model.onnx', size: 2e9, format: 'onnx' as const, nativeSupported: true },
      { path: 'model.onnx.data', size: 3e9, format: 'onnx' as const, nativeSupported: true },
      { path: 'tokenizer.json', size: 8192, format: 'config' as const, nativeSupported: false }
    ]
    expect(isOnnxGenaiChatRepo(files, [], undefined, 'org/model')).toBe(true)
    expect(isContentStudioSnapshotRepo(files, [], undefined, 'org/model')).toBe(false)
  })

  it('does not treat bare config.json as a Content Studio snapshot', () => {
    const files = [
      { path: 'config.json', size: 2000, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 500000, format: 'onnx' as const, nativeSupported: true },
      { path: 'tokenizer.json', size: 1e6, format: 'config' as const, nativeSupported: false }
    ]
    expect(isContentStudioSnapshotRepo(files, ['text-generation'], 'text-generation', 'org/SmolLM3-3B-ONNX')).toBe(
      false
    )
    expect(isOnnxGenaiChatRepo(files, ['text-generation'], 'text-generation', 'org/SmolLM3-3B-ONNX')).toBe(true)
  })

  it('treats DINOv2 ONNX as vision encoder snapshot, not chat', () => {
    const files = [
      { path: 'config.json', size: 988, format: 'config' as const, nativeSupported: false },
      { path: 'preprocessor_config.json', size: 436, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 90000000, format: 'onnx' as const, nativeSupported: true }
    ]
    const repo = 'onnx-community/dinov2-base-ONNX'
    expect(isOnnxVisionEncoderRepo(files, [], undefined, repo)).toBe(true)
    expect(isOnnxGenaiChatRepo(files, [], undefined, repo)).toBe(false)
    expect(isContentStudioSnapshotRepo(files, [], undefined, repo)).toBe(true)
  })

  it('detects onnx-community text repos without genai_config.json', () => {
    const files = [
      { path: 'config.json', size: 2000, format: 'config' as const, nativeSupported: false },
      { path: 'model.safetensors', size: 1.5e9, format: 'safetensors' as const, nativeSupported: false },
      { path: 'onnx/model_q4f16.onnx', size: 500000, format: 'onnx' as const, nativeSupported: true },
      { path: 'onnx/model_q4f16.onnx_data', size: 4.5e8, format: 'onnx' as const, nativeSupported: true },
      { path: 'tokenizer.json', size: 1.9e7, format: 'config' as const, nativeSupported: false },
      { path: 'tokenizer_config.json', size: 9000, format: 'config' as const, nativeSupported: false },
      { path: 'chat_template.jinja', size: 7000, format: 'config' as const, nativeSupported: false }
    ]
    const repo = 'onnx-community/Qwen3.5-0.8B-Text-ONNX'
    expect(isOnnxGenaiChatRepo(files, ['text-generation'], 'text-generation', repo)).toBe(true)
    expect(inferOnnxRepoKind(files, ['text-generation'], 'text-generation', repo)).toBe('chat')
    expect(isContentStudioSnapshotRepo(files, ['text-generation'], 'text-generation', repo)).toBe(
      false
    )
  })
})

describe('inferOnnxRepoKind', () => {
  it('classifies DINOv2 as vision encoder, not chat', () => {
    const files = [
      { path: 'config.json', size: 988, format: 'config' as const, nativeSupported: false },
      { path: 'preprocessor_config.json', size: 436, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 90000000, format: 'onnx' as const, nativeSupported: true }
    ]
    const repo = 'onnx-community/dinov2-base-ONNX'
    expect(inferOnnxRepoKind(files, [], 'image-feature-extraction', repo)).toBe('vision_encoder')
    expect(isOnnxGenaiChatRepo(files, [], 'image-feature-extraction', repo)).toBe(false)
  })

  it('classifies Qwen3-Embedding as embedding, not chat', () => {
    const files = [
      { path: 'config.json', size: 2000, format: 'config' as const, nativeSupported: false },
      { path: 'tokenizer.json', size: 1e6, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 500000, format: 'onnx' as const, nativeSupported: true }
    ]
    const repo = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
    expect(inferOnnxRepoKind(files, [], 'feature-extraction', repo)).toBe('embedding')
    expect(isOnnxGenaiChatRepo(files, [], 'feature-extraction', repo)).toBe(false)
  })

  it('classifies Kokoro TTS as speech', () => {
    const files = [
      { path: 'config.json', size: 2000, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 500000, format: 'onnx' as const, nativeSupported: true }
    ]
    expect(inferOnnxRepoKind(files, [], 'text-to-speech', 'onnx-community/Kokoro-82M-ONNX')).toBe('speech')
  })

  it('classifies SmolLM3 with text-generation pipeline as chat', () => {
    const files = [
      { path: 'config.json', size: 2000, format: 'config' as const, nativeSupported: false },
      { path: 'tokenizer.json', size: 1e6, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 500000, format: 'onnx' as const, nativeSupported: true },
      { path: 'chat_template.jinja', size: 7000, format: 'config' as const, nativeSupported: false }
    ]
    const repo = 'onnx-community/SmolLM3-3B-ONNX'
    expect(inferOnnxRepoKind(files, ['text-generation'], 'text-generation', repo)).toBe('chat')
    expect(isOnnxGenaiChatRepo(files, ['text-generation'], 'text-generation', repo)).toBe(true)
  })

  it('classifies Florence-2 as multimodal, not vision encoder', () => {
    const files = [
      { path: 'config.json', size: 2000, format: 'config' as const, nativeSupported: false },
      { path: 'preprocessor_config.json', size: 436, format: 'config' as const, nativeSupported: false },
      { path: 'tokenizer.json', size: 1e6, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 90000000, format: 'onnx' as const, nativeSupported: true }
    ]
    const repo = 'onnx-community/Florence-2-base-ONNX'
    expect(inferOnnxRepoKind(files, [], 'image-text-to-text', repo)).toBe('multimodal')
    expect(isOnnxVisionEncoderRepo(files, [], 'image-text-to-text', repo)).toBe(false)
  })
})

describe('resolveOnnxGenaiPaths', () => {
  it('collects genai marker, onnx weights, and tokenizer files', () => {
    const files = [
      { path: 'genai_config.json', size: 100, format: 'config' as const, nativeSupported: false },
      { path: 'model.onnx', size: 1e9, format: 'onnx' as const, nativeSupported: true },
      { path: 'model.onnx.data', size: 2e9, format: 'onnx' as const, nativeSupported: true },
      { path: 'tokenizer.json', size: 100, format: 'config' as const, nativeSupported: false },
      { path: 'README.md', size: 100, format: 'other' as const, nativeSupported: false }
    ]
    expect(resolveOnnxGenaiPaths(files)).toEqual([
      'genai_config.json',
      'model.onnx',
      'model.onnx.data',
      'tokenizer.json'
    ])
  })

  it('picks one quant variant for onnx-community repos', () => {
    const files = [
      { path: 'config.json', size: 100, format: 'config' as const, nativeSupported: false },
      { path: 'onnx/model.onnx', size: 1e6, format: 'onnx' as const, nativeSupported: true },
      { path: 'onnx/model.onnx_data', size: 2e9, format: 'onnx' as const, nativeSupported: true },
      { path: 'onnx/model_q4f16.onnx', size: 5e5, format: 'onnx' as const, nativeSupported: true },
      { path: 'onnx/model_q4f16.onnx_data', size: 4e8, format: 'onnx' as const, nativeSupported: true },
      { path: 'tokenizer.json', size: 100, format: 'config' as const, nativeSupported: false },
      { path: 'generation_config.json', size: 100, format: 'config' as const, nativeSupported: false }
    ]
    expect(resolveOnnxGenaiPaths(files)).toEqual([
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'config.json',
      'tokenizer.json',
      'generation_config.json'
    ])
  })

  it('picks one nested Microsoft Phi genai pack (CPU over GPU)', () => {
    const cpuPack = 'cpu_and_mobile/cpu-int4-awq-block-128-acc-level-4'
    const gpuPack = 'gpu/gpu-int4-awq-block-128'
    const files = [
      { path: 'config.json', size: 3451, format: 'config' as const, nativeSupported: false },
      { path: `${cpuPack}/genai_config.json`, size: 1580, format: 'config' as const, nativeSupported: false },
      {
        path: `${cpuPack}/phi-3.5-mini-instruct-cpu-int4-awq-block-128-acc-level-4.onnx`,
        size: 52_176_615,
        format: 'onnx' as const,
        nativeSupported: true
      },
      {
        path: `${cpuPack}/phi-3.5-mini-instruct-cpu-int4-awq-block-128-acc-level-4.onnx.data`,
        size: 2_728_144_896,
        format: 'onnx' as const,
        nativeSupported: true
      },
      { path: `${cpuPack}/tokenizer.json`, size: 1_844_436, format: 'config' as const, nativeSupported: false },
      { path: `${cpuPack}/tokenizer_config.json`, size: 3364, format: 'config' as const, nativeSupported: false },
      { path: `${cpuPack}/config.json`, size: 3451, format: 'config' as const, nativeSupported: false },
      { path: `${gpuPack}/genai_config.json`, size: 1531, format: 'config' as const, nativeSupported: false },
      { path: `${gpuPack}/model.onnx`, size: 26_188_036, format: 'onnx' as const, nativeSupported: true },
      { path: `${gpuPack}/model.onnx.data`, size: 2_291_335_168, format: 'onnx' as const, nativeSupported: true },
      { path: `${gpuPack}/tokenizer.json`, size: 3_620_657, format: 'config' as const, nativeSupported: false }
    ]
    const paths = resolveOnnxGenaiPaths(files)
    expect(paths.some((p) => p.startsWith(`${cpuPack}/`))).toBe(true)
    expect(paths.some((p) => p.startsWith(`${gpuPack}/`))).toBe(false)
    expect(paths).toContain(`${cpuPack}/genai_config.json`)
    expect(paths).toContain(`${cpuPack}/phi-3.5-mini-instruct-cpu-int4-awq-block-128-acc-level-4.onnx`)
  })
})

describe('inferContentStudioKind', () => {
  it('infers image for diffusion repo ids', () => {
    expect(inferContentStudioKind('cutycat2000/InterDiffusion-Nano', [])).toBe('image')
  })

  it('infers tts from pipeline tag', () => {
    expect(inferContentStudioKind('org/model', [], 'text-to-speech')).toBe('tts')
  })

  it('infers video for LTX-Video and text-to-video pipeline', () => {
    expect(inferContentStudioKind('Lightricks/LTX-Video-0.9.5', ['text-to-video'], 'text-to-video')).toBe(
      'video'
    )
  })
})
