import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContentGenerationCatalog, ModelInfo, OmegaConfig, OmegaToolsSettings } from '@omega/sdk'
import { ContentStudioImageOptions } from './ContentStudioImageOptions'
import { ContentStudioVideoOptions } from './ContentStudioVideoOptions'
import { ContentStudioPipelineSettings } from './ContentStudioPipelineSettings'
import { ImageResolutionControl } from './ImageResolutionControl'
import {
  STATIC_SUGGESTED_IMAGE,
  STATIC_SUGGESTED_TTS,
  STATIC_SUGGESTED_VIDEO
} from '../lib/content-studio-catalog-static'
import { loadGenerationCatalog } from '../lib/load-generation-catalog'
import { engineClient } from '../lib/engine'

const STT_OPTIONS = [{ id: 'browser', label: 'System / browser speech recognition' }]

const TTS_OPTIONS = [
  { id: 'browser', label: 'System / OS speech (recommended)' },
  { id: 'content_studio', label: 'Content Studio TTS model (below)' }
]

type MediaAccelCaps = {
  imageAccelerator?: string
  ttsAccelerator?: string
  videoAccelerator?: string
  contentStudioGeneration?: {
    accelerators?: {
      image?: { label?: string; accelerator?: string }
      tts?: { label?: string; accelerator?: string }
      video?: { label?: string; accelerator?: string }
    }
  }
}

function mediaAccelLabel(caps: MediaAccelCaps, kind: 'image' | 'tts' | 'video'): string {
  const row = caps.contentStudioGeneration?.accelerators?.[kind]
  if (row?.label) return row.label
  const id =
    row?.accelerator ??
    (kind === 'image'
      ? caps.imageAccelerator
      : kind === 'tts'
        ? caps.ttsAccelerator
        : caps.videoAccelerator)
  if (id === 'cuda') return 'CUDA'
  if (id === 'directml') return 'DirectML'
  if (id === 'cpu') return 'CPU'
  return id ?? '—'
}

export function OmegaToolsSettingsBlock({
  config,
  models,
  onSave
}: {
  config: OmegaConfig
  models: ModelInfo[]
  onSave: (patch: Partial<OmegaConfig>) => Promise<void>
}) {
  const [tools, setTools] = useState<OmegaToolsSettings>(() => ({
    voiceEnabled: false,
    voiceOutputEnabled: false,
    voiceSttModelId: 'browser',
    voiceTtsModelId: 'browser',
    ...config.omegaTools
  }))
  const [catalog, setCatalog] = useState<ContentGenerationCatalog | null>(null)
  const [caps, setCaps] = useState<MediaAccelCaps | null>(null)
  const [chatImageW, setChatImageW] = useState(() => config.imageGeneration?.width ?? 0)
  const [chatImageH, setChatImageH] = useState(() => config.imageGeneration?.height ?? 0)
  const [chatImageUseOllama, setChatImageUseOllama] = useState(
    () => Boolean(config.imageGeneration?.useOllama)
  )
  const [chatImageOllama, setChatImageOllama] = useState(
    () => config.imageGeneration?.ollamaModel ?? 'flux'
  )
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setTools({
      voiceEnabled: false,
      voiceOutputEnabled: false,
      voiceSttModelId: 'browser',
      voiceTtsModelId: 'browser',
      ...config.omegaTools
    })
    setChatImageW(config.imageGeneration?.width ?? 0)
    setChatImageH(config.imageGeneration?.height ?? 0)
    setChatImageUseOllama(Boolean(config.imageGeneration?.useOllama))
    setChatImageOllama(config.imageGeneration?.ollamaModel ?? 'flux')
  }, [
    config.omegaTools,
    config.imageGeneration?.width,
    config.imageGeneration?.height,
    config.imageGeneration?.useOllama,
    config.imageGeneration?.ollamaModel
  ])

  const reloadCatalog = useCallback(() => {
    void loadGenerationCatalog().then(setCatalog)
    void engineClient.inference
      .mediaCapabilities()
      .then((c) => setCaps(c as MediaAccelCaps))
      .catch(() => setCaps(null))
  }, [])

  useEffect(() => {
    reloadCatalog()
  }, [reloadCatalog])

  useEffect(() => {
    const off = engineClient.models.onInventoryChanged(reloadCatalog)
    const offCs = engineClient.contentStudio.onChanged(reloadCatalog)
    return () => {
      off()
      offCs()
    }
  }, [reloadCatalog])

  const suggestedTts = useMemo(
    () => catalog?.suggested_tts_models ?? catalog?.tts_models ?? STATIC_SUGGESTED_TTS,
    [catalog]
  )
  const suggestedImage = useMemo(
    () => catalog?.suggested_image_models ?? catalog?.image_models ?? STATIC_SUGGESTED_IMAGE,
    [catalog]
  )
  const installedTts = useMemo(() => catalog?.installed_tts ?? [], [catalog])
  const installedImage = useMemo(() => catalog?.installed_image ?? [], [catalog])
  const suggestedVideo = useMemo(
    () => catalog?.suggested_video_models ?? catalog?.video_models ?? STATIC_SUGGESTED_VIDEO,
    [catalog]
  )
  const installedVideo = useMemo(() => catalog?.installed_video ?? [], [catalog])
  const catalogDefaults = useMemo(
    () => ({
      tts: STATIC_SUGGESTED_TTS[0]?.repo_id ?? 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      image: STATIC_SUGGESTED_IMAGE[0]?.repo_id ?? 'cutycat2000/InterDiffusion-Nano',
      video:
        catalog?.defaults?.video ??
        STATIC_SUGGESTED_VIDEO[0]?.repo_id ??
        'Lightricks/LTX-Video-0.9.5'
    }),
    [catalog]
  )
  const catalogSafe = useMemo(
    () => ({ defaults: catalog?.defaults ?? catalogDefaults }),
    [catalog, catalogDefaults]
  )

  const save = useCallback(async () => {
    await onSave({
      omegaTools: tools,
      imageGeneration: {
        ...config.imageGeneration,
        width: chatImageW,
        height: chatImageH,
        useOllama: chatImageUseOllama,
        ollamaModel: chatImageOllama.trim() || 'flux'
      }
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [onSave, tools, config.imageGeneration, chatImageW, chatImageH, chatImageUseOllama, chatImageOllama])

  const refreshCatalog = reloadCatalog

  return (
    <div className="space-y-4 text-sm">
      <p className="text-zinc-500">
        Voice, local media playback, and chat image resolution. Default chat and Content Studio models
        are configured under Models → Model roles.
      </p>

      <ContentStudioPipelineSettings />

      {caps && (
        <div className="rounded border border-zinc-800/80 bg-zinc-950/30 px-3 py-2 text-[11px] text-zinc-500">
          <p className="font-medium text-zinc-400 mb-1">Content Studio GPU (PyTorch)</p>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <span className="text-zinc-600">Image</span>
              <p className="text-zinc-300">{mediaAccelLabel(caps, 'image')}</p>
            </div>
            <div>
              <span className="text-zinc-600">TTS</span>
              <p className="text-zinc-300">{mediaAccelLabel(caps, 'tts')}</p>
            </div>
            <div>
              <span className="text-zinc-600">Video</span>
              <p className="text-zinc-300">{mediaAccelLabel(caps, 'video')}</p>
            </div>
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Separate from chat GPU (CUDA / Vulkan / Metal). AMD/Intel on Windows uses DirectML when
            torch-directml is installed.
          </p>
        </div>
      )}

      <label className="block text-xs text-zinc-400">
        Content Studio — image VRAM
        <select
          className="mt-1 w-full max-w-md rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
          value={tools.contentStudioImageVramMode ?? 'all_gpu'}
          onChange={(e) =>
            setTools((t) => ({
              ...t,
              contentStudioImageVramMode: e.target.value as 'all_gpu' | 'auto' | 'offload_encoders'
            }))
          }
        >
          <option value="all_gpu">All on GPU (recommended)</option>
          <option value="auto">Auto — offload on GPUs under ~10&nbsp;GiB</option>
          <option value="offload_encoders">Offload text encoders to CPU (saves VRAM)</option>
        </select>
        <span className="mt-1 block text-[10px] text-zinc-600">
          Default matches the standalone image tool (full pipeline on GPU). Auto only offloads CLIP on
          small GPUs (&lt;10&nbsp;GiB total VRAM). Offload encoders is slower but frees VRAM on tight cards.
        </span>
      </label>

      <ContentStudioImageOptions
        baseRepoId={tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image}
        modelMeta={
          suggestedImage.find(
            (m) =>
              m.repo_id === (tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image)
          ) ??
          installedImage.find(
            (m) =>
              m.repo_id === (tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image)
          )
        }
        steps={
          tools.contentStudioImageStepsByRepo?.[
            tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image
          ] ?? 0
        }
        size={
          tools.contentStudioImageSizeByRepo?.[
            tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image
          ]
        }
        adapters={tools.contentStudioImageAdapters ?? []}
        onStepsChange={(n) => {
          const repo = tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image
          setTools((t) => ({
            ...t,
            contentStudioImageStepsByRepo: { ...(t.contentStudioImageStepsByRepo ?? {}), [repo]: n }
          }))
        }}
        onSizeChange={(sz) => {
          const repo = tools.contentStudioImageRepoId?.trim() || catalogSafe.defaults.image
          setTools((t) => {
            const next = { ...(t.contentStudioImageSizeByRepo ?? {}) }
            if (!sz || (sz.width === 0 && sz.height === 0)) {
              delete next[repo]
            } else {
              next[repo] = sz
            }
            return { ...t, contentStudioImageSizeByRepo: next }
          })
        }}
        onAdaptersChange={(rows) => setTools((t) => ({ ...t, contentStudioImageAdapters: rows }))}
      />

      <ContentStudioVideoOptions
        baseRepoId={tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video}
        modelMeta={
          suggestedVideo.find(
            (m) =>
              m.repo_id === (tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video)
          ) ??
          installedVideo.find(
            (m) =>
              m.repo_id === (tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video)
          )
        }
        steps={
          tools.contentStudioVideoStepsByRepo?.[
            tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video
          ] ?? 0
        }
        size={
          tools.contentStudioVideoSizeByRepo?.[
            tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video
          ]
        }
        onStepsChange={(n) => {
          const repo = tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video
          setTools((t) => ({
            ...t,
            contentStudioVideoStepsByRepo: { ...(t.contentStudioVideoStepsByRepo ?? {}), [repo]: n }
          }))
        }}
        onSizeChange={(sz) => {
          const repo = tools.contentStudioVideoRepoId?.trim() || catalogSafe.defaults.video
          setTools((t) => {
            const next = { ...(t.contentStudioVideoSizeByRepo ?? {}) }
            if (!sz || (sz.width === 0 && sz.height === 0)) {
              delete next[repo]
            } else {
              next[repo] = sz
            }
            return { ...t, contentStudioVideoSizeByRepo: next }
          })
        }}
      />

      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-400">Chat — image_generate tool</p>
        <p className="text-[10px] text-zinc-600">
          Chat uses your loaded model when it can generate images; otherwise it uses the image model
          from Models → Model roles. Ollama options below apply only when the chat model is an
          Ollama image model.
        </p>
        <label className="flex items-start gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={chatImageUseOllama}
            onChange={(e) => setChatImageUseOllama(e.target.checked)}
          />
          <span>
            Prefer Ollama for chat images
            <span className="mt-0.5 block text-[10px] text-zinc-600">
              Optional. When off, Omega still uses Ollama if that is the only image backend available.
            </span>
          </span>
        </label>
        <label className="block text-xs text-zinc-400">
          Preferred Ollama image model
          <input
            className="mt-1 w-full max-w-xs rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs"
            value={chatImageOllama}
            placeholder="flux"
            onChange={(e) => setChatImageOllama(e.target.value)}
          />
        </label>
        <ImageResolutionControl
          label="Output resolution"
          showVideoAspect={false}
          size={
            chatImageW > 0 && chatImageH > 0
              ? { width: chatImageW, height: chatImageH }
              : undefined
          }
          catalogWidth={1024}
          catalogHeight={1024}
          onChange={(sz) => {
            if (!sz || (sz.width === 0 && sz.height === 0)) {
              setChatImageW(0)
              setChatImageH(0)
              return
            }
            setChatImageW(sz.width)
            setChatImageH(sz.height)
          }}
        />
      </div>

      <label className="block text-xs text-zinc-400">
        Media library folder (for “play music from …”)
        <input
          className="mt-1 w-full max-w-md rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
          value={tools.mediaLibraryPath ?? ''}
          placeholder="e.g. C:\Users\You\Music"
          onChange={(e) => setTools((t) => ({ ...t, mediaLibraryPath: e.target.value }))}
        />
      </label>

      <div className="rounded border border-zinc-800 bg-zinc-950/50 p-3 space-y-4">
        <div>
          <h4 className="text-sm font-medium text-zinc-300">Voice</h4>
          <p className="mt-1 text-xs text-zinc-500">
            Voice input uses your microphone; voice output reads assistant replies aloud after each
            answer (typed or spoken prompts).
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={Boolean(tools.voiceEnabled)}
            onChange={(e) => setTools((t) => ({ ...t, voiceEnabled: e.target.checked }))}
          />
          <span>
            Voice input (microphone in chat)
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">
              Shows the mic button in chat when your browser supports speech recognition.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={Boolean(tools.voiceOutputEnabled ?? tools.voiceEnabled)}
            onChange={(e) =>
              setTools((t) => ({ ...t, voiceOutputEnabled: e.target.checked }))
            }
          />
          <span>
            Speak assistant replies
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">
              After each text reply, Omega reads the answer using your operating system&apos;s built-in
              speech engine (Windows / macOS / browser TTS).
            </span>
          </span>
        </label>

        {(tools.voiceEnabled || (tools.voiceOutputEnabled ?? tools.voiceEnabled)) && (
          <div className="grid gap-3 md:grid-cols-2">
            {tools.voiceEnabled && (
              <label className="block text-xs text-zinc-400">
                Speech recognition (user voice)
                <select
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                  value={tools.voiceSttModelId ?? 'browser'}
                  onChange={(e) => setTools((t) => ({ ...t, voiceSttModelId: e.target.value }))}
                >
                  {STT_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(tools.voiceOutputEnabled ?? tools.voiceEnabled) && (
              <label className="block text-xs text-zinc-400">
                Text-to-speech (assistant voice)
                <select
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                  value={tools.voiceTtsModelId ?? 'browser'}
                  onChange={(e) => setTools((t) => ({ ...t, voiceTtsModelId: e.target.value }))}
                >
                  {TTS_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                  {installedTts.map((m) => (
                    <option key={m.repo_id} value={m.repo_id}>
                      CS: {m.key}
                    </option>
                  ))}
                </select>
                {(tools.voiceTtsModelId ?? 'browser') !== 'browser' && (
                  <span className="mt-1 block text-[10px] text-zinc-600">
                    Neural TTS falls back to system speech when the model is unavailable.
                  </span>
                )}
              </label>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => void save()}
        className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white"
      >
        Save Omega tools
      </button>
      {saved && <span className="ml-2 text-xs text-emerald-400">Saved</span>}
    </div>
  )
}
