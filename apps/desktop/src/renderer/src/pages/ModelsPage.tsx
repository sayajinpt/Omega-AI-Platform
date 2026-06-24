import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  ContentGenerationCatalog,
  GpuDevice,
  HFFile,
  HFModelCard,
  HFSearchResult,
  ModelConfig,
  ModelInfo
} from '@omega/sdk'
import { buildHfSearchOptions, HF_PIPELINE_TASKS, pipelinePrefersAnyFormat } from '@omega/sdk'
import { Toggle } from '../components/Slider'
import { MODEL_HUB } from '../data/model-hub'
import { parseHfRepoInput } from '../lib/hf-repo-input'
import { ModelSettingsPanel } from '../components/ModelSettingsPanel'
import { ModelCapabilityBadges } from '../components/ModelCapabilityBadges'
import { normalizeModelId } from '../lib/model-id'
import { engineClient, refreshRuntimeSnapshot, useModelLoad } from '../lib/engine'
import type { DownloadJob } from '../lib/useDownloadQueue'
import { downloadJobPercent } from '../lib/useDownloadQueue'
import { isDownloadJobActive, stopAllDownloadJobs, stopDownloadJob } from '../lib/download-queue-actions'
import { HfGatedModelDialog, type HfGatedDialogState } from '../components/HfGatedModelDialog'
import { gatedDialogFromError, probeHfRepoBeforeDownload } from '../lib/hf-download'
import { ModelDiscoverPanel } from '../components/ModelDiscoverPanel'
import { ModelSearchFiltersPanel } from '../components/ModelSearchFiltersPanel'
import { ModelRepoFilesPanel } from '../components/ModelRepoFilesPanel'
import {
  defaultModelSearchFilters,
  effectiveFileSizeBytes,
  formatFileGiB,
  inferContextK,
  inferParamBillions,
  passesFileSizeBytes,
  passesHfResultFilters,
  type ModelSearchFilterState
} from '../lib/model-search-filters'

function formatBytes(n: number): string {
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function formatSpeed(bps: number): string {
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
}

/** Derive capability hints from repo + filename before download. */
function cardTagsFromPath(repoId: string, filePath: string): string[] {
  const hub = MODEL_HUB.find((h) => h.repo === repoId || repoId.endsWith(h.repo.split('/').pop() ?? ''))
  if (hub) return [...hub.tags, hub.category]
  return [repoId, filePath]
}

type Tab = 'discover' | 'search' | 'installed' | 'download'

const CS_SNAPSHOT_FILENAME = '(Content Studio snapshot)'

export function ModelsPage({
  models,
  onRefresh,
  config,
  downloadJobs,
  setDownloadJobs,
  onOpenSettings
}: {
  models: ModelInfo[]
  onRefresh: () => void
  config: { defaultModel: string; modelsDir: string }
  downloadJobs: DownloadJob[]
  setDownloadJobs: Dispatch<SetStateAction<DownloadJob[]>>
  onOpenSettings?: () => void
}) {
  const [tab, setTab] = useState<Tab>('discover')
  const [searchBootstrapped, setSearchBootstrapped] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const jobs = downloadJobs
  const setJobs = setDownloadJobs
  const [activeModel, setActiveModel] = useState('')
  const [loaded, setLoaded] = useState<string[]>([])

  const [repo, setRepo] = useState('bartowski/Llama-3.2-3B-Instruct-GGUF')
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [quantInput, setQuantInput] = useState('')
  const [quantOut, setQuantOut] = useState('model-q4')
  const [quantMsg, setQuantMsg] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [searchFilters, setSearchFilters] = useState<ModelSearchFilterState>(defaultModelSearchFilters)
  const [searchAuthor, setSearchAuthor] = useState('')
  const [searchTag, setSearchTag] = useState('')
  const [searchSort, setSearchSort] = useState<'downloads' | 'likes' | 'lastModified' | 'trending'>('trending')
  const [searchLimit, setSearchLimit] = useState(100)
  const [searchFormat, setSearchFormat] = useState<
    'gguf' | 'safetensors' | 'awq' | 'gptq' | 'mlx' | 'onnx' | 'exl2' | 'any'
  >('gguf')
  const [searchVerified, setSearchVerified] = useState(false)
  const [searchResults, setSearchResults] = useState<HFSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [card, setCard] = useState<HFModelCard | null>(null)
  const [cardLoading, setCardLoading] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [configureModel, setConfigureModel] = useState<string | null>(null)
  const [modelConfigs, setModelConfigs] = useState<Record<string, ModelConfig>>({})
  const [gpus, setGpus] = useState<GpuDevice[]>([])
  const [hfGated, setHfGated] = useState<HfGatedDialogState | null>(null)
  const [hfRetry, setHfRetry] = useState<(() => void) | null>(null)
  const [genCatalog, setGenCatalog] = useState<ContentGenerationCatalog | null>(null)
  const gpuList = Array.isArray(gpus) ? gpus : []
  const gpuTotalMb = gpuList.reduce((acc, g) => acc + (g.kind !== 'cpu' ? g.memory_mb ?? 0 : 0), 0)
  const systemRamMb = (gpuList.find((g) => g.kind === 'cpu')?.memory_mb ?? 16 * 1024)

  const {
    load: loadModel,
    unload: unloadModel,
    busy: modelLoadBusy
  } = useModelLoad({ onRefresh })

  const refreshRuntime = useCallback(async () => {
    const snap = await refreshRuntimeSnapshot()
    setActiveModel(snap.activeModel)
    setLoaded(snap.loadedModels)
  }, [])

  useEffect(() => {
    refreshRuntime()
    engineClient.hf.tags().then(setTags).catch(() => {})
    engineClient.gpu
      .list()
      .then((g) => setGpus(Array.isArray(g) ? g : []))
      .catch(() => setGpus([]))
  }, [refreshRuntime])

  useEffect(() => {
    void engineClient.modelConfig.list().then(setModelConfigs).catch(() => {})
  }, [models.length])

  useEffect(() => {
    void engineClient.contentStudio.generation.catalog().then(setGenCatalog).catch(() => {})
  }, [])

  useEffect(() => {
    if (!card?.id) return
    void engineClient.contentStudio.generation
      .catalog()
      .then(setGenCatalog)
      .catch(() => {})
  }, [card?.id])

  useEffect(() => {
    return engineClient.models.onInventoryChanged(() => {
      void engineClient.contentStudio.generation
        .catalog()
        .then(setGenCatalog)
        .catch(() => {})
    })
  }, [])

  const generationInstalledForCard = useMemo(() => {
    if (!card?.id || !genCatalog) return { tts: false, image: false, video: false }
    const id = card.id
    return {
      tts: genCatalog.installed_tts?.some((m) => m.repo_id === id) ?? false,
      image: genCatalog.installed_image?.some((m) => m.repo_id === id) ?? false,
      video: genCatalog.installed_video?.some((m) => m.repo_id === id) ?? false
    }
  }, [card?.id, genCatalog])

  const isInstalled = (file: string) => {
    const norm = normalizeModelId(file)
    return models.some((m) => m.id === norm || m.id === file)
  }

  const runDownload = async (entryRepo: string, entryFile: string) => {
    setTab('download')
    setJobs((prev) => [
      ...prev,
      { repo: entryRepo, filename: entryFile, percent: 0, status: 'starting', speed_bps: 0 }
    ])
    await engineClient.models.download(entryRepo, entryFile)
    await onRefresh()
    await refreshRuntime()
  }

  const removeDownloadFromQueue = (job: DownloadJob) => {
    setJobs((prev) => prev.filter((j) => j.repo !== job.repo || j.filename !== job.filename))
  }

  const cancelDownloadJob = async (job: DownloadJob) => {
    try {
      await stopDownloadJob(job)
    } finally {
      removeDownloadFromQueue(job)
    }
  }

  const cancelAllDownloads = async () => {
    const snapshot = [...jobs]
    if (!snapshot.length) return
    try {
      await stopAllDownloadJobs(snapshot)
    } finally {
      setJobs([])
    }
  }

  const startDownload = async (entryRepo: string, entryFile: string) => {
    setBusy(true)
    setHfRetry(() => () => void startDownload(entryRepo, entryFile))
    try {
      const blocked = await probeHfRepoBeforeDownload(entryRepo)
      if (blocked) {
        setHfGated(blocked)
        setJobs((prev) =>
          prev.filter((j) => !(j.repo === entryRepo && j.filename === entryFile))
        )
        return
      }
      await runDownload(entryRepo, entryFile)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const dialog = gatedDialogFromError(entryRepo, e)
      if (dialog) {
        setHfGated(dialog)
        setJobs((prev) =>
          prev.filter((j) => !(j.repo === entryRepo && j.filename === entryFile))
        )
      } else {
        alert(msg)
        if (/404|does not exist|outdated/i.test(msg)) {
          void engineClient.models.openHfRepo(entryRepo)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const startGenerationSnapshotDownload = async (
    entryRepo: string,
    kind: 'tts' | 'image' | 'video',
    sizeHint: string
  ) => {
    setTab('download')
    setJobs((prev) => [
      ...prev,
      {
        repo: entryRepo,
        filename: CS_SNAPSHOT_FILENAME,
        percent: 0,
        status: 'starting',
        speed_bps: 0
      }
    ])
    setHfRetry(() => () => void startGenerationSnapshotDownload(entryRepo, kind, sizeHint))
    try {
      const blocked = await probeHfRepoBeforeDownload(entryRepo)
      if (blocked) {
        setHfGated(blocked)
        setJobs((prev) =>
          prev.filter((j) => !(j.repo === entryRepo && j.filename === CS_SNAPSHOT_FILENAME))
        )
        return
      }
      const label = entryRepo.split('/').pop() ?? entryRepo
      await engineClient.contentStudio.generation.downloadModel(kind, entryRepo, label, sizeHint)
    } catch (e) {
      const dialog = gatedDialogFromError(entryRepo, e)
      if (dialog) setHfGated(dialog)
      else alert(e instanceof Error ? e.message : String(e))
      setJobs((prev) =>
        prev.filter((j) => !(j.repo === entryRepo && j.filename === CS_SNAPSHOT_FILENAME))
      )
    }
  }

  const startDownloadAllRequired = async (
    entryRepo: string,
    entryFiles: HFFile[],
    opts?: { primaryPath?: string; visionPath?: string; tags?: string[]; format?: string }
  ) => {
    if (!entryFiles.length) return
    setBusy(true)
    setTab('download')
    setHfRetry(() => () => void startDownloadAllRequired(entryRepo, entryFiles, opts))
    try {
      const blocked = await probeHfRepoBeforeDownload(entryRepo)
      if (blocked) {
        setHfGated(blocked)
        return
      }
      await engineClient.models.downloadRequired({
        repo: entryRepo,
        files: entryFiles,
        primaryPath: opts?.primaryPath,
        visionPath: opts?.visionPath,
        tags: opts?.tags,
        format: opts?.format
      })
      await onRefresh()
      await refreshRuntime()
    } catch (e) {
      const dialog = gatedDialogFromError(entryRepo, e)
      if (dialog) setHfGated(dialog)
      else alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadModelIntoCatalog = async (id: string) => {
    try {
      await loadModel(id)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const unloadModelFromCatalog = async (id: string) => {
    try {
      await unloadModel(id)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const listFiles = async () => {
    setBusy(true)
    try {
      const list = await engineClient.models.repoFiles(repo)
      setFiles(list)
      const q4 = list.find((f) => /Q4_K_M/i.test(f)) ?? list[0]
      if (q4) setSelected(q4)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runQuantize = async () => {
    if (!quantInput.trim()) return
    setBusy(true)
    setQuantMsg('Starting…')
    const off = engineClient.models.onQuantizeProgress((p) => {
      const q = p as { status?: string; percent?: number; message?: string }
      setQuantMsg(`${q.status} ${q.percent ?? ''}% ${q.message ?? ''}`)
    })
    try {
      await engineClient.models.quantize({ inputPath: quantInput, outputName: quantOut, quant: 'Q4_K_M' })
      setQuantMsg('Done')
      onRefresh()
    } catch (e) {
      setQuantMsg(e instanceof Error ? e.message : String(e))
    } finally {
      off()
      setBusy(false)
    }
  }

  const runSearch = async (opts?: {
    pipeline?: string
    format?: typeof searchFormat
  }) => {
    const q = searchQ.trim()
    const pipeline = opts?.pipeline ?? searchFilters.pipeline
    let format = opts?.format ?? searchFormat
    if (pipeline.trim() && pipelinePrefersAnyFormat(pipeline) && format === 'gguf') {
      format = 'any'
    }
    setSearching(true)
    try {
      setSearchResults(
        await engineClient.hf.search(
          buildHfSearchOptions({
            query: q || undefined,
            author: searchAuthor || undefined,
            tag: searchTag || undefined,
            pipeline: pipeline.trim() || undefined,
            sort: searchSort,
            limit: searchLimit,
            format,
            preferVerifiedQuantizers: searchVerified
          })
        )
      )
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  const onPipelineFilterChange = (pipeline: string) => {
    if (pipelinePrefersAnyFormat(pipeline) && searchFormat === 'gguf') {
      setSearchFormat('any')
    }
    void runSearch({ pipeline, format: pipelinePrefersAnyFormat(pipeline) ? 'any' : searchFormat })
  }

  const openRepoCard = async (repoId: string) => {
    const id = repoId.trim()
    if (!id) return
    setTab('search')
    setRepo(id)
    setRepoInput(id)
    setCard(null)
    setCardLoading(true)
    try {
      setCard(await engineClient.hf.card(id))
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setCardLoading(false)
    }
  }

  const openAnyRepo = async () => {
    const parsed = parseHfRepoInput(repoInput)
    if (!parsed) {
      alert(
        'Paste a Hugging Face model URL or type owner/repo (example: bartowski/mistralai_Devstral-Small-2505-GGUF).'
      )
      return
    }
    await openRepoCard(parsed)
  }

  useEffect(() => {
    if (tab !== 'search' || searchBootstrapped) return
    setSearchBootstrapped(true)
    void runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap HF browse when tab first opened
  }, [tab, searchBootstrapped])

  const filteredSearchResults = useMemo(
    () => searchResults.filter((r) => passesHfResultFilters(r, searchFilters)),
    [searchResults, searchFilters]
  )

  const pipelineOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of searchResults) {
      if (r.pipeline?.trim()) set.add(r.pipeline.trim())
    }
    return [...set].sort()
  }, [searchResults])

  const filteredCardFiles = useMemo(() => {
    if (!card) return []
    return card.files.filter((file) => {
      if (!passesFileSizeBytes(effectiveFileSizeBytes(file, card.files), searchFilters)) return false
      if (searchFilters.quant.trim()) {
        const want = searchFilters.quant.trim().toUpperCase()
        if (!file.quant?.toUpperCase().includes(want)) return false
      }
      return true
    })
  }, [card, searchFilters])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h2 className="text-lg font-semibold">Model Studio</h2>
        <p className="text-sm text-zinc-500">
          <strong>Discover</strong> — curated model cards · <strong>Browse HF</strong> — any Hugging Face repo ·{' '}
          {config.modelsDir}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void openAnyRepo()
            }}
            placeholder="Paste Hugging Face URL or owner/repo (any public or gated model)…"
            className="min-w-[16rem] flex-1 rounded-lg border border-indigo-700/50 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || cardLoading}
            onClick={() => void openAnyRepo()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {cardLoading ? 'Loading…' : 'Open model'}
          </button>
          {repoInput.trim() ? (
            <button
              type="button"
              className="rounded-lg border border-zinc-600 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              onClick={() => {
                const parsed = parseHfRepoInput(repoInput)
                if (parsed) void engineClient.models.openHfRepo(parsed)
              }}
            >
              View on HF ↗
            </button>
          ) : null}
        </div>
        <details className="mt-2 text-xs text-zinc-500">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
            Supported formats &amp; what runs where
          </summary>
          <div className="mt-2 space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-[11px]">
            <p>
              Omega ships <strong>two bundled inference engines</strong> — everything runs
              in-process, no remote server required.
            </p>
            <p>
              <strong className="text-emerald-300">GGUF</strong> →{' '}
              <code>omega-engine</code> (libomega_infer · CPU · CUDA · Vulkan). Fast, quantized,
              best for chat. Requires <code>omega-engine</code> in the install (build with build.bat).
            </p>
            <p>
              <strong className="text-emerald-300">safetensors · AWQ · GPTQ · Ollama-native</strong>{' '}
              → bundled <code>omega-ollama</code> runtime, auto-started on a private
              loopback port. Same UX, no Python, no separate install.
            </p>
            <p className="text-zinc-500">
              <strong className="text-violet-300">EXL2</strong> → ExLlamaV2 sidecar.{' '}
              <strong className="text-fuchsia-300">ONNX GenAI</strong> → onnxruntime-genai sidecar.
              Install from <strong>Settings → Performance → Optional inference engines</strong>.{' '}
              <strong className="text-zinc-400">MLX</strong> still needs a custom Provider (Apple).
            </p>
          </div>
        </details>
        <div className="mt-3 flex gap-2">
          {(['discover', 'search', 'installed', 'download'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
            >
              {t === 'search' ? 'Browse HF' : t === 'discover' ? 'Discover' : t}
              {t === 'download' && jobs.length > 0 ? ` (${jobs.length})` : ''}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'discover' && (
          <ModelDiscoverPanel
            models={models}
            busy={busy || modelLoadBusy}
            gpuTotalMb={gpuTotalMb}
            onDownload={(entryRepo, entryFile) => void startDownload(entryRepo, entryFile)}
            onOpenRepo={(repoId) => void openRepoCard(repoId)}
            onBrowseHf={() => setTab('search')}
          />
        )}

        {tab === 'search' && (
          <div className="flex h-full gap-4">
            <div className="flex w-1/2 flex-col">
              <div className="mb-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') await runSearch()
                    }}
                    placeholder="Search all Hugging Face models (name, family, task)…"
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={searching}
                    onClick={() => void runSearch()}
                    className="rounded-lg bg-indigo-600 px-3 text-sm"
                  >
                    {searching ? 'Searching…' : 'Search'}
                  </button>
                </div>
                <ModelSearchFiltersPanel
                  filters={searchFilters}
                  onChange={setSearchFilters}
                  onReset={() => setSearchFilters(defaultModelSearchFilters())}
                  pipelineOptions={pipelineOptions}
                  onPipelineChange={onPipelineFilterChange}
                  showFileSize
                  showQuant={searchFormat === 'gguf'}
                />
                <div className="flex flex-wrap gap-1.5">
                  {HF_PIPELINE_TASKS.slice(0, 12).map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        const next = searchFilters.pipeline === task.id ? '' : task.id
                        setSearchFilters((f) => ({ ...f, pipeline: next }))
                        onPipelineFilterChange(next)
                      }}
                      className={`rounded-full px-2.5 py-1 text-[10px] ring-1 transition ${
                        searchFilters.pipeline === task.id
                          ? 'bg-indigo-600 text-white ring-indigo-500'
                          : 'bg-zinc-900 text-zinc-400 ring-zinc-700 hover:text-zinc-200'
                      }`}
                    >
                      {task.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={searchAuthor}
                    onChange={(e) => setSearchAuthor(e.target.value)}
                    placeholder="author (e.g. bartowski)"
                    className="w-44 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                  />
                  <select
                    value={searchTag}
                    onChange={(e) => setSearchTag(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                  >
                    <option value="">all tags</option>
                    {tags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    value={searchSort}
                    onChange={(e) => setSearchSort(e.target.value as typeof searchSort)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                  >
                    <option value="downloads">most downloads</option>
                    <option value="likes">most likes</option>
                    <option value="trending">trending</option>
                    <option value="lastModified">recently updated</option>
                  </select>
                  <select
                    value={searchLimit}
                    onChange={(e) => setSearchLimit(Number(e.target.value))}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                  >
                    <option value={50}>50 results</option>
                    <option value={100}>100 results</option>
                    <option value={250}>250 results</option>
                    <option value={500}>500 results</option>
                    <option value={1000}>1000 results</option>
                  </select>
                  <select
                    value={searchFormat}
                    onChange={(e) => setSearchFormat(e.target.value as typeof searchFormat)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                    title="Weight format"
                  >
                    <option value="gguf">GGUF (native)</option>
                    <option value="safetensors">safetensors</option>
                    <option value="awq">AWQ</option>
                    <option value="gptq">GPTQ</option>
                    <option value="exl2">EXL2</option>
                    <option value="mlx">MLX (Apple)</option>
                    <option value="onnx">ONNX</option>
                    <option value="any">any format</option>
                  </select>
                  {searchFormat === 'gguf' && !searchAuthor && (
                    <label
                      className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                      title="Optional: only show GGUF from well-known quantizers (bartowski, unsloth, lmstudio-community, …). Off = full Hugging Face catalog."
                    >
                      <input
                        type="checkbox"
                        checked={searchVerified}
                        onChange={(e) => setSearchVerified(e.target.checked)}
                      />
                      Staff-pick uploaders only
                    </label>
                  )}
                </div>
                {searchFormat === 'any' && (
                  <p className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-2 text-[10px] text-zinc-300">
                    <strong>Any format</strong> searches the full Hugging Face Hub. After you open a
                    repo, each file shows how Omega loads it:{' '}
                    <span className="text-emerald-300">GGUF</span> (native),{' '}
                    <span className="text-sky-300">safetensors / AWQ / GPTQ</span> (bundled Ollama),{' '}
                    <span className="text-amber-300">EXL2 / MLX / ONNX</span> (custom Provider).
                  </p>
                )}
                {searchFormat === 'exl2' && (
                  <p className="rounded-lg border border-violet-800/60 bg-violet-950/30 p-2 text-[10px] text-violet-200">
                    <strong>EXL2</strong> runs natively via ExLlamaV2 after{' '}
                    <strong>Settings → Performance</strong> (NVIDIA GPU, ~2 GB download).
                  </p>
                )}
                {searchFormat === 'onnx' && (
                  <p className="rounded-lg border border-fuchsia-800/60 bg-fuchsia-950/30 p-2 text-[10px] text-fuchsia-200">
                    <strong>ONNX</strong> runs natively via ONNX Runtime GenAI after{' '}
                    <strong>Settings → Performance</strong> (CUDA / DirectML / CPU).
                  </p>
                )}
                {searchFormat === 'mlx' && (
                  <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-2 text-[10px] text-amber-200">
                    <strong>MLX</strong> is downloadable but not auto-routed yet (Apple-only). Add a
                    custom Provider entry to use it.
                  </p>
                )}
                {(searchFormat === 'safetensors' || searchFormat === 'awq' || searchFormat === 'gptq') && (
                  <p className="rounded-lg border border-sky-800/60 bg-sky-950/30 p-2 text-[10px] text-sky-200">
                    <strong>{searchFormat.toUpperCase()}</strong> runs in the bundled{' '}
                    <code>omega-ollama</code> engine (in-process, no remote server).
                  </p>
                )}
                {searchResults.length > 0 && (
                  <p className="text-[10px] text-zinc-500">
                    {filteredSearchResults.length} of {searchResults.length} repos match filters ·{' '}
                    {searchFormat === 'any' ? '' : `${searchFormat.toUpperCase()} `}
                    Click one for files + README.
                  </p>
                )}
              </div>
              <ul className="flex-1 space-y-2 overflow-y-auto pr-1">
                {filteredSearchResults.map((r) => {
                  const paramsB = inferParamBillions(r.id, r.tags)
                  const ctxK = inferContextK(r.id, r.tags)
                  return (
                  <li
                    key={r.id}
                    className={`cursor-pointer rounded-lg border p-3 transition ${card?.id === r.id ? 'border-indigo-600 bg-indigo-950/30' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}
                    onClick={() => void openRepoCard(r.id)}
                  >
                    <p className="truncate font-mono text-sm text-indigo-300">{r.id}</p>
                    <ModelCapabilityBadges
                      compact
                      input={{ name: r.id, tags: r.tags, pipeline: r.pipeline }}
                    />
                    <p className="mt-1 text-xs text-zinc-500">
                      ▼ {r.downloads.toLocaleString()} · ♥ {r.likes}
                      {paramsB !== null ? ` · ~${paramsB}B` : ''}
                      {ctxK !== null ? ` · ~${ctxK >= 1000 ? `${ctxK / 1000}M` : `${ctxK}K`} ctx` : ''}
                      {r.lastModified && ` · ${new Date(r.lastModified).toLocaleDateString()}`}
                    </p>
                  </li>
                  )
                })}
                {searchResults.length === 0 && !searching && (
                  <p className="text-sm text-zinc-500">
                    Search above, paste a repo at the top, or press Search with an empty query to browse
                    popular GGUF models on Hugging Face.
                  </p>
                )}
                {searchResults.length > 0 && filteredSearchResults.length === 0 && !searching && (
                  <p className="text-sm text-amber-200/90">
                    No results match the current filters. Widen ranges or reset filters.
                  </p>
                )}
              </ul>
            </div>
            <div className="flex w-1/2 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
              {cardLoading && <p className="p-4 text-sm text-zinc-400">Loading…</p>}
              {card && (
                <>
                  <header className="border-b border-zinc-800 p-4">
                    <p className="font-mono text-sm text-indigo-300">{card.id}</p>
                    <ModelCapabilityBadges
                      input={{
                        name: card.id,
                        description: card.description,
                        tags: card.tags,
                        readme: card.readme,
                        pipeline: card.pipeline
                      }}
                    />
                    <p className="mt-2 text-xs text-zinc-500">
                      ▼ {card.downloads.toLocaleString()} · ♥ {card.likes}
                    </p>
                  </header>
                  <div className="flex-1 overflow-y-auto p-4">
                    {card.files.length > 0 && filteredCardFiles.length === 0 ? (
                      <ModelRepoFilesPanel
                        repoId={card.id}
                        files={[]}
                        allFiles={card.files}
                        tags={card.tags}
                        pipeline={card.pipeline}
                        busy={busy || modelLoadBusy}
                        gpuTotalMb={gpuTotalMb}
                        filteredCount={0}
                        totalCount={card.files.length}
                        generationInstalled={generationInstalledForCard}
                        onDownloadFile={(path) => void startDownload(card.id, path)}
                        onDownloadReady={(chatPath, visionPath) =>
                          void startDownloadAllRequired(card.id, card.files, {
                            primaryPath: chatPath,
                            visionPath,
                            tags: card.tags
                          })
                        }
                        onDownloadOnnxReady={() =>
                          void startDownloadAllRequired(card.id, card.files, {
                            tags: card.tags,
                            format: 'onnx'
                          })
                        }
                        onDownloadGenerationSnapshot={(kind, sizeHint) =>
                          void startGenerationSnapshotDownload(card.id, kind, sizeHint)
                        }
                      />
                    ) : (
                      <ModelRepoFilesPanel
                        repoId={card.id}
                        files={filteredCardFiles}
                        allFiles={card.files}
                        tags={card.tags}
                        pipeline={card.pipeline}
                        busy={busy || modelLoadBusy}
                        gpuTotalMb={gpuTotalMb}
                        filteredCount={filteredCardFiles.length}
                        totalCount={card.files.length}
                        generationInstalled={generationInstalledForCard}
                        onDownloadFile={(path) => void startDownload(card.id, path)}
                        onDownloadReady={(chatPath, visionPath) =>
                          void startDownloadAllRequired(card.id, card.files, {
                            primaryPath: chatPath,
                            visionPath,
                            tags: card.tags
                          })
                        }
                        onDownloadOnnxReady={() =>
                          void startDownloadAllRequired(card.id, card.files, {
                            tags: card.tags,
                            format: 'onnx'
                          })
                        }
                        onDownloadGenerationSnapshot={(kind, sizeHint) =>
                          void startGenerationSnapshotDownload(card.id, kind, sizeHint)
                        }
                      />
                    )}
                    {card.readme && (
                      <>
                        <h4 className="mb-2 mt-4 text-xs uppercase text-zinc-500">README</h4>
                        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 text-xs text-zinc-400">
                          {card.readme.slice(0, 8000)}
                        </pre>
                      </>
                    )}
                  </div>
                </>
              )}
              {!card && !cardLoading && (
                <p className="p-4 text-sm text-zinc-500">
                  Select a result to see files, download options, and README.
                </p>
              )}
            </div>
          </div>
        )}

        {tab === 'installed' && (
          <div className="max-w-3xl space-y-3">
            {models.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
                <p className="text-zinc-400">No models installed yet.</p>
                <div className="mt-3 flex justify-center gap-4 text-sm">
                  <button type="button" onClick={() => setTab('discover')} className="text-indigo-400 hover:underline">
                    Discover →
                  </button>
                  <button type="button" onClick={() => setTab('search')} className="text-indigo-400 hover:underline">
                    Browse HF →
                  </button>
                </div>
              </div>
            ) : (
              models.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  isActive={loaded.includes(m.id)}
                  isLoaded={loaded.includes(m.id)}
                  busy={busy || modelLoadBusy}
                  onLoad={() => loadModelIntoCatalog(m.id)}
                  onUnload={() => unloadModelFromCatalog(m.id)}
                  onConfigure={() => setConfigureModel(m.id)}
                  onDelete={async () => {
                    if (confirm(`Delete ${m.id}?`)) {
                      await engineClient.models.delete(m.id)
                      onRefresh()
                      refreshRuntime()
                    }
                  }}
                  onBench={async () => setDetail(await engineClient.models.benchmark(m.id))}
                  onVram={async () => setDetail(await engineClient.models.footprint(m.id))}
                />
              ))
            )}
            {detail && (
              <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-4 text-xs text-emerald-300">{JSON.stringify(detail, null, 2)}</pre>
            )}
          </div>
        )}

        {tab === 'download' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">Download queue</h3>
                {jobs.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void cancelAllDownloads()}
                    className="rounded-lg border border-zinc-600 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Cancel all
                  </button>
                ) : null}
              </div>
              {jobs.length === 0 ? (
                <p className="text-sm text-zinc-500">No active downloads.</p>
              ) : (
                <ul className="space-y-4">
                  {jobs.map((j) => {
                    const active = isDownloadJobActive(j)
                    const pct = downloadJobPercent(j)
                    return (
                    <li key={`${j.repo}/${j.filename}`} className="rounded-lg bg-zinc-950 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{j.filename}</p>
                          <p className="truncate text-xs text-zinc-500">{j.repo}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void cancelDownloadJob(j)}
                          className="shrink-0 rounded-lg border border-red-800/60 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/40"
                          title={active ? 'Stop download' : 'Remove from queue'}
                        >
                          {active ? 'Stop' : 'Remove'}
                        </button>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full bg-indigo-500 transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-zinc-400">
                        {j.detail ?? j.status}
                        {pct > 0 ? ` · ${pct.toFixed(1)}%` : ''}
                        {j.speed_bps > 0 ? ` · ${formatSpeed(j.speed_bps)}` : ''}
                        {(j.bytes_done ?? 0) > 0 && (j.bytes_total ?? 0) > 0
                          ? ` · ${formatBytes(j.bytes_done ?? 0)} / ${formatBytes(j.bytes_total ?? 0)}`
                          : (j.bytes_done ?? 0) > 0
                            ? ` · ${formatBytes(j.bytes_done ?? 0)}`
                            : ''}
                      </p>
                    </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <h3 className="mb-3 font-medium">Open any Hugging Face repo</h3>
              <p className="mb-2 text-xs text-zinc-500">
                Same as the bar at the top — paste a URL or <code className="text-zinc-400">owner/repo</code>, list
                files, then download.
              </p>
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const parsed = parseHfRepoInput(repo)
                    if (parsed) void openRepoCard(parsed)
                  }
                }}
                className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                placeholder="https://huggingface.co/author/model or author/model"
              />
              <div className="mb-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || cardLoading}
                  onClick={() => {
                    const parsed = parseHfRepoInput(repo)
                    if (parsed) void openRepoCard(parsed)
                    else alert('Enter a valid Hugging Face model URL or owner/repo.')
                  }}
                  className="rounded-lg border border-indigo-600 px-3 py-1.5 text-sm text-indigo-200"
                >
                  Load files
                </button>
                <button type="button" onClick={listFiles} disabled={busy} className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm">
                  List weight files
                </button>
                <button
                  type="button"
                  onClick={() => selected && startDownload(repo, selected)}
                  disabled={busy || !selected}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm"
                >
                  Download selected
                </button>
                {files.length > 1 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const hfFiles: HFFile[] = files.map((path) => ({
                        path,
                        size: 0,
                        format: 'gguf',
                        nativeSupported: true
                      }))
                      void startDownloadAllRequired(repo, hfFiles, { primaryPath: selected || undefined })
                    }}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                  >
                    Download ready set
                  </button>
                )}
              </div>
              {files.length > 0 && (
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm"
                >
                  {files.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              )}
              <h3 className="mb-2 mt-6 font-medium text-sm text-zinc-400">Quantize</h3>
              <input
                value={quantInput}
                onChange={(e) => setQuantInput(e.target.value)}
                placeholder="Path to source .gguf"
                className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
              <input
                value={quantOut}
                onChange={(e) => setQuantOut(e.target.value)}
                placeholder="Output name"
                className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
              <button type="button" onClick={runQuantize} disabled={busy} className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm">
                Quantize Q4_K_M
              </button>
              {quantMsg && <p className="mt-2 text-xs text-zinc-400">{quantMsg}</p>}
            </section>
          </div>
        )}
      </div>

      {configureModel && (
        <ModelSettingsPanel
          modelId={configureModel}
          onClose={() => setConfigureModel(null)}
          onSaved={() => {
            void engineClient.modelConfig.list().then(setModelConfigs).catch(() => {})
            refreshRuntime()
            onRefresh()
          }}
        />
      )}

      <HfGatedModelDialog
        state={hfGated}
        onClose={() => setHfGated(null)}
        onRetry={hfRetry ?? undefined}
        onOpenSettings={onOpenSettings}
      />
    </div>
  )
}

function FileRow({
  file,
  files,
  repoId,
  gpuTotalMb,
  systemRamMb,
  onDownload
}: {
  file: HFFile
  files: HFFile[]
  repoId: string
  gpuTotalMb: number
  systemRamMb: number
  onDownload: () => void
}) {
  const diskBytes = effectiveFileSizeBytes(file, files)
  const [est, setEst] = useState<{ weightsMb: number; kvCacheMb: number; vramMb: number; ramMbIfCpu: number } | null>(
    null
  )
  useEffect(() => {
    if (!file.nativeSupported) return
    let cancel = false
    engineClient.modelMeta
      .estimateFile(diskBytes, 4096, file.quant)
      .then((e) => !cancel && setEst(e))
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [diskBytes, file.quant, file.nativeSupported])

  const fitGpu = est && gpuTotalMb > 0 ? est.vramMb <= gpuTotalMb : null
  const fitRam = est ? est.ramMbIfCpu <= systemRamMb : null

  const fmt = (mb: number): string => (mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(2)} GB`)

  const formatLabel = file.format.toUpperCase()
  const bundledOllama = ['safetensors', 'awq', 'gptq', 'pytorch'].includes(file.format)
  const engine: 'gguf' | 'exl2' | 'onnx' | 'ollama' | 'external' = file.format === 'gguf'
    ? 'gguf'
    : file.format === 'exl2'
      ? 'exl2'
      : file.format === 'onnx'
        ? 'onnx'
        : bundledOllama
          ? 'ollama'
          : 'external'
  const formatTone =
    engine === 'gguf' || engine === 'exl2' || engine === 'onnx'
      ? engine === 'exl2'
        ? 'bg-violet-700/30 text-violet-200'
        : engine === 'onnx'
          ? 'bg-fuchsia-700/30 text-fuchsia-200'
          : 'bg-emerald-700/30 text-emerald-200'
      : engine === 'ollama'
        ? 'bg-sky-700/30 text-sky-200'
        : 'bg-amber-800/40 text-amber-200'
  const engineTitle =
    engine === 'gguf'
      ? 'GGUF — omega-engine (libomega_infer)'
      : engine === 'exl2'
        ? 'EXL2 — native ExLlamaV2 (install in Settings → Performance)'
        : engine === 'onnx'
        ? 'ONNX — native ONNX Runtime GenAI (install in Settings → Performance)'
      : engine === 'ollama'
        ? `${formatLabel} — bundled Ollama runtime (in-process)`
        : `${formatLabel} — needs a custom Provider entry (MLX not bundled yet)`

  return (
    <li className="rounded bg-zinc-950 p-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${formatTone}`}
              title={engineTitle}
            >
              {formatLabel}
            </span>
            <p className="truncate font-mono text-xs">{file.path}</p>
          </div>
          <ModelCapabilityBadges
            compact
            max={4}
            input={{ name: `${repoId}/${file.path}`, tags: cardTagsFromPath(repoId, file.path) }}
          />
          <p className="text-[10px] text-zinc-500">
            Disk: {formatFileGiB(diskBytes)}
            {file.quant && ` · ${file.quant}`}
            {engine === 'ollama' && ' · bundled Ollama engine'}
            {(engine === 'exl2' || engine === 'onnx') && ' · optional engine (Settings → Performance)'}
            {engine === 'external' && ' · custom Provider required'}
          </p>
        </div>
        <button
          type="button"
          onClick={onDownload}
          className="rounded bg-emerald-700 px-2 py-1 text-xs"
        >
          Download
        </button>
      </div>
      {est && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
          <span
            className={`rounded px-2 py-1 ${
              fitGpu === null
                ? 'bg-zinc-800 text-zinc-400'
                : fitGpu
                  ? 'bg-emerald-900/40 text-emerald-300'
                  : 'bg-amber-900/40 text-amber-300'
            }`}
            title="Estimated VRAM if fully loaded on GPU"
          >
            GPU: ~{fmt(est.vramMb)}
            {gpuTotalMb > 0 && ` / ${fmt(gpuTotalMb)}`}
          </span>
          <span
            className={`rounded px-2 py-1 ${
              fitRam ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300'
            }`}
            title="RAM needed if running entirely on CPU"
          >
            RAM (CPU only): ~{fmt(est.ramMbIfCpu)}
          </span>
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400" title="KV cache for 4K context">
            KV @ 4K: {fmt(est.kvCacheMb)}
          </span>
        </div>
      )}
      {est && fitGpu === false && (
        <p className="mt-1 text-[10px] text-amber-400">
          Won't fully fit in GPU — Omega will offload extra layers to RAM (hybrid mode).
        </p>
      )}
    </li>
  )
}

function ModelRow({
  model,
  isActive,
  isLoaded,
  busy,
  onLoad,
  onUnload,
  onConfigure,
  onDelete,
  onBench,
  onVram
}: {
  model: ModelInfo
  isActive: boolean
  isLoaded: boolean
  busy: boolean
  onLoad: () => void
  onUnload: () => void
  onConfigure: () => void
  onDelete: () => void
  onBench: () => void
  onVram: () => void
}) {
  return (
    <div className={`rounded-xl border p-4 ${isActive ? 'border-indigo-600 bg-indigo-950/20' : 'border-zinc-800 bg-zinc-900/50'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-indigo-300">{model.id}</p>
          <p className="text-xs text-zinc-500">
            {formatBytes(model.size_bytes)} · {model.metadata.quantization ?? '—'} · ctx {model.metadata.context_len ?? '?'}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">manual</span>
            {isLoaded && (
              <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-[10px] text-emerald-400">in memory</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={onLoad} disabled={busy || isLoaded} className="rounded-lg bg-indigo-600 px-3 py-1 text-xs disabled:opacity-40">
            {isLoaded ? 'Loaded' : 'Load'}
          </button>
          <button type="button" onClick={onUnload} disabled={busy || !isLoaded} className="rounded-lg border border-zinc-600 px-3 py-1 text-xs disabled:opacity-40">
            Unload
          </button>
          <button type="button" onClick={onConfigure} className="rounded-lg border border-indigo-600/60 px-3 py-1 text-xs text-indigo-300 hover:bg-indigo-950/40">
            Configure
          </button>
          <button type="button" onClick={onBench} className="text-xs text-zinc-400 hover:text-white">
            Bench
          </button>
          <button type="button" onClick={onVram} className="text-xs text-zinc-400 hover:text-white">
            VRAM
          </button>
          <button type="button" onClick={onDelete} className="text-xs text-red-400">
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
