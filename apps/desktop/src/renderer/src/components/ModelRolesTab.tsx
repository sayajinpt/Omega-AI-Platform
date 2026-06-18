import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContentGenerationCatalog, ModelInfo, OmegaConfig } from '@omega/sdk'
import { ContentStudioModelField } from './ContentStudioModelField'
import {
  STATIC_SUGGESTED_IMAGE,
  STATIC_SUGGESTED_TTS,
  STATIC_SUGGESTED_VIDEO
} from '../lib/content-studio-catalog-static'
import { loadGenerationCatalog } from '../lib/load-generation-catalog'
import { engineClient } from '../lib/engine'
import { GenerationModelCapabilities } from './GenerationModelCapabilities'
import type { InputPipeline } from '@omega/sdk'

export function ModelRolesTab({
  config,
  models,
  onConfigChanged
}: {
  config: OmegaConfig
  models: ModelInfo[]
  onConfigChanged?: () => void
}) {
  const [defaultModel, setDefaultModel] = useState(config.defaultModel ?? '')
  const [tools, setTools] = useState(() => ({ ...config.omegaTools }))
  const [pipelines, setPipelines] = useState<InputPipeline[]>([])
  const [chatPipelineId, setChatPipelineId] = useState(config.activeChatPipelineId ?? '')
  const [contentPipelineId, setContentPipelineId] = useState(config.activeContentPipelineId ?? '')
  const [catalog, setCatalog] = useState<ContentGenerationCatalog | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDefaultModel(config.defaultModel ?? '')
    setTools({ ...config.omegaTools })
    setChatPipelineId(config.activeChatPipelineId ?? '')
    setContentPipelineId(config.activeContentPipelineId ?? '')
  }, [config])

  const reloadCatalog = useCallback(() => {
    void loadGenerationCatalog()
      .then(setCatalog)
      .catch(() => setCatalog(null))
  }, [])

  useEffect(() => {
    reloadCatalog()
    void engineClient.inputPipelines.list().then(setPipelines).catch(() => setPipelines([]))
  }, [reloadCatalog])

  useEffect(() => {
    const off = engineClient.models.onInventoryChanged(reloadCatalog)
    return off
  }, [reloadCatalog])

  const chatPipelines = useMemo(
    () => pipelines.filter((p) => p.scope === 'chat' || p.scope === 'custom'),
    [pipelines]
  )
  const contentPipelines = useMemo(
    () => pipelines.filter((p) => p.scope === 'content' || p.scope === 'custom'),
    [pipelines]
  )
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

  const save = async () => {
    await engineClient.config.set({
      defaultModel,
      omegaTools: tools,
      activeChatPipelineId: chatPipelineId || undefined,
      activeContentPipelineId: contentPipelineId || undefined
    })
    if (chatPipelineId) await engineClient.inputPipelines.setActive('chat', chatPipelineId)
    if (contentPipelineId) await engineClient.inputPipelines.setActive('content', contentPipelineId)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    onConfigChanged?.()
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto p-6 text-sm">
      <p className="text-zinc-500">
        Default models and active input pipelines for chat and Content Studio. The LLM orchestrator
        uses these when planning and executing agent turns.
      </p>

      {catalog?.models_root && (
        <p className="text-[10px] text-zinc-600">Models root: {catalog.models_root}</p>
      )}

      <label className="block text-xs text-zinc-400">
        Default chat model
        <select
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-zinc-400">
        Active chat input pipeline
        <select
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
          value={chatPipelineId}
          onChange={(e) => setChatPipelineId(e.target.value)}
        >
          <option value="">Default (first chat pipeline)</option>
          {chatPipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-zinc-400">
        Active content input pipeline
        <select
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
          value={contentPipelineId}
          onChange={(e) => setContentPipelineId(e.target.value)}
        >
          <option value="">Default (first content pipeline)</option>
          {contentPipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <ContentStudioModelField
        label="Content Studio — TTS model"
        kind="tts"
        value={tools.contentStudioTtsRepoId ?? ''}
        suggestedModels={suggestedTts}
        installedModels={installedTts}
        automaticLabel={`Automatic (${catalog?.defaults?.tts ?? 'default'})`}
        onChange={(repoId) => setTools((t) => ({ ...t, contentStudioTtsRepoId: repoId }))}
        onCatalogReload={reloadCatalog}
      />
      <GenerationModelCapabilities modality="tts" repoId={tools.contentStudioTtsRepoId ?? ''} />

      <ContentStudioModelField
        label="Content Studio — image model"
        kind="image"
        value={tools.contentStudioImageRepoId ?? ''}
        suggestedModels={suggestedImage}
        installedModels={installedImage}
        automaticLabel={`Automatic (${catalog?.defaults?.image ?? 'default'})`}
        onChange={(repoId) => setTools((t) => ({ ...t, contentStudioImageRepoId: repoId }))}
        onCatalogReload={reloadCatalog}
      />
      <GenerationModelCapabilities modality="image" repoId={tools.contentStudioImageRepoId ?? ''} />

      <ContentStudioModelField
        label="Text-to-video model"
        kind="video"
        value={tools.contentStudioVideoRepoId ?? ''}
        suggestedModels={suggestedVideo}
        installedModels={installedVideo}
        automaticLabel="Automatic (first installed video pack)"
        onChange={(repoId) => setTools((t) => ({ ...t, contentStudioVideoRepoId: repoId }))}
        onCatalogReload={reloadCatalog}
      />
      <GenerationModelCapabilities modality="video" repoId={tools.contentStudioVideoRepoId ?? ''} />

      <button
        type="button"
        onClick={() => void save()}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium"
      >
        {saved ? 'Saved' : 'Save model roles'}
      </button>
    </div>
  )
}
