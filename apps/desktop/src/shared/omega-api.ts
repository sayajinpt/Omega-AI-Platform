import type { OmegaRuntimeBridge } from './omega-http-bridge'
import {
  parseAvatarMonitorEnabledPayload,
  parseAvatarMonitorLayoutPayload,
  parseAvatarMonitorSignalsPayload
} from './avatar-monitor-payload'
import { hfRepoPageUrl, requestOmegaBrowser } from './browser-open'
import { IPC } from './ipc'
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentStep,
  ChatRequest,
  ContextBufferState,
  CronJob,
  DebugEvent,
  DecisionNode,
  GatewayPlatformConfig,
  GatewayPlatformId,
  GatewayStatus,
  GenerateResult,
  GpuDevice,
  HFModelCard,
  HFSearchOptions,
  HFSearchResult,
  KanbanStatus,
  KanbanTask,
  McpServerConfig,
  McpServerStatus,
  MemoryEntry,
  MemoryEstimate,
  ModelConfig,
  ModelInfo,
  ModelMetadata,
  OmegaConfig,
  PluginCatalogEntry,
  PluginInfo,
  PluginManifest,
  Profile,
  QuantizeRequest,
  RagHit,
  RagSource,
  RemoteProvider,
  Skill,
  SkillContent,
  Soul,
  Token,
  ToolApprovalRequest,
  CapabilityPermissionRequest,
  ToolInfo,
  Workflow,
  WorkflowRunEvent,
  WorkflowRunResult,
  BrowserBounds,
  BrowserStatus,
  FinetuneJob,
  FinetuneDatasetEntry,
  FinetuneDatasetPreset,
  FinetuneSourceInspect,
  FinetuneModality,
  TerminalLine,
  FinetuneModelProfile,
  FinetunePrepareDatasetRequest,
  FinetuneProgress,
  FinetuneStartRequest,
  ContentSchedule,
  ContentSeries,
  ContentSocialAccount,
  ContentSocialPlatform,
  ContentSocialPost,
  ContentStudioCredentials,
  ContentStudioGenerationSettings,
  ContentGenerationCatalog,
  GenerationCapabilities,
  ContentStudioProject,
  ContentStudioRun,
  ContentStudioRunStatus,
  ContentStudioSetupProgress,
  ContentStudioStatus,
  EngineCommandPayload,
  EngineCommandResponse,
  EngineCommandType
} from '@omega/sdk'

/** Build window.omega API surface (HTTP to omega-runtime; optional shell IPC for menu events). */
export function createOmegaApi(bridge: OmegaRuntimeBridge) {
  return {
  config: {
    get: (): Promise<OmegaConfig> => bridge.invoke(IPC.configGet),
    set: (patch: Partial<OmegaConfig>): Promise<OmegaConfig> => bridge.invoke(IPC.configSet, patch),
    onChanged: (cb: (cfg: OmegaConfig) => void) => {
      const fn = (_: unknown, cfg: OmegaConfig) => cb(cfg)
      bridge.on(IPC.configChanged, fn)
      return () => bridge.removeListener(IPC.configChanged, fn)
    }
  },
  permissions: {
    onRequest: (cb: (req: CapabilityPermissionRequest) => void) => {
      const fn = (_: unknown, p: CapabilityPermissionRequest) => cb(p)
      bridge.on(IPC.capabilityPermissionRequest, fn)
      return () => bridge.removeListener(IPC.capabilityPermissionRequest, fn)
    },
    resolve: (id: string, approved: boolean, remember?: boolean) =>
      bridge.invoke(IPC.capabilityPermissionResolve, id, approved, remember)
  },
  modelConfig: {
    get: (modelId: string): Promise<ModelConfig> => bridge.invoke(IPC.modelConfigGet, modelId),
    reset: (modelId: string): Promise<ModelConfig> => bridge.invoke(IPC.modelConfigReset, modelId),
    set: (modelId: string, cfg: Partial<ModelConfig>): Promise<ModelConfig> =>
      bridge.invoke(IPC.modelConfigSet, modelId, cfg),
    list: (): Promise<Record<string, ModelConfig>> => bridge.invoke(IPC.modelConfigList)
  },
  modelPresets: {
    list: (): Promise<Array<{ id: string; label: string; description: string; patch: Partial<ModelConfig> }>> =>
      bridge.invoke(IPC.modelPresetsList),
    apply: (modelId: string, presetId: string): Promise<ModelConfig> =>
      bridge.invoke(IPC.modelPresetsApply, modelId, presetId)
  },
  runtime: {
    status: (): Promise<{
      state: string
      error?: string
      inference?: string
      activeModel?: string
      nativeLoaded?: string
      routedModel?: string
      runtimeLoadedStems?: string[]
      resolvedCatalogIds?: string[]
    }> =>
      bridge.invoke(IPC.runtimeStatus),
    loadedModels: (): Promise<string[]> => bridge.invoke(IPC.loadedModels),
    onStatusChanged: (
      cb: (s: {
        state: string
        activeModel: string
        nativeLoaded: string
        routedModel: string
        runtimeLoadedStems?: string[]
        resolvedCatalogIds?: string[]
      }) => void
    ) => {
      const fn = (
        _: unknown,
        s: {
          state: string
          activeModel: string
          nativeLoaded: string
          routedModel: string
          runtimeLoadedStems?: string[]
          resolvedCatalogIds?: string[]
        }
      ) => cb(s)
      bridge.on(IPC.runtimeStatusChanged, fn)
      return () => bridge.removeListener(IPC.runtimeStatusChanged, fn)
    }
  },
  system: {
    info: (): Promise<Record<string, unknown>> => bridge.invoke(IPC.systemInfo)
  },
  inference: {
    backend: (): Promise<string> => bridge.invoke(IPC.inferenceBackend),
    backends: (): Promise<
      Array<{ backend: 'cuda' | 'vulkan' | 'metal' | 'cpu'; available: boolean; error?: string }>
    > => bridge.invoke(IPC.inferenceBackends),
    switch: (modelId: string): Promise<void> => bridge.invoke(IPC.inferenceSwitch, modelId),
    mediaCapabilities: (): Promise<Record<string, unknown>> =>
      bridge.invoke(IPC.inferenceMediaCapabilities),
    mediaImage: (body: {
      prompt: string
      modelId?: string
      width?: number
      height?: number
    }): Promise<Record<string, unknown>> => bridge.invoke(IPC.inferenceMediaImage, body),
    mediaTts: (body: {
      text: string
      outPath: string
      modelId?: string
    }): Promise<Record<string, unknown>> => bridge.invoke(IPC.inferenceMediaTts, body)
  },
  engines: {
    status: (): Promise<{
      omegaEngine: {
        name: string
        kind: string
        present: boolean
        available: boolean
        state?: string
        error?: string
        inferAvailable?: boolean
      }
      runtime: {
        name: string
        kind: string
        state: string
        error?: string
        backend?: string
      }
      ollama: {
        name: string
        kind: string
        available: boolean
        running: boolean
        port?: number
        pid?: number
        version?: string
        error?: string
      }
      sidecar?: {
        name: string
        kind: string
        scriptPresent: boolean
        venvPresent: boolean
        running: boolean
      }
    }> => bridge.invoke(IPC.enginesStatus),
    startOllama: () => bridge.invoke(IPC.enginesOllamaStart),
    stopOllama: () => bridge.invoke(IPC.enginesOllamaStop),
    listOllama: (): Promise<Array<{ name: string; size: number }>> =>
      bridge.invoke(IPC.enginesOllamaList),
    pullOllama: (name: string) => bridge.invoke(IPC.enginesOllamaPull, name),
    onPullProgress: (
      cb: (e: { name: string; status: string; completed?: number; total?: number }) => void
    ) => {
      const h = (_: unknown, p: { name: string; status: string; completed?: number; total?: number }) => cb(p)
      bridge.on(IPC.enginesOllamaPullProgress, h)
      return () => bridge.removeListener(IPC.enginesOllamaPullProgress, h)
    },
    sidecarStatus: () => bridge.invoke(IPC.sidecarStatus),
    installSidecar: (components: Array<'exl2' | 'onnx'>) =>
      bridge.invoke(IPC.sidecarInstall, components),
    uninstallSidecar: () => bridge.invoke(IPC.sidecarUninstall),
    onSidecarInstallProgress: (
      cb: (e: { phase: string; detail: string }) => void
    ) => {
      const h = (_: unknown, p: { phase: string; detail: string }) => cb(p)
      bridge.on(IPC.sidecarInstallProgress, h)
      return () => bridge.removeListener(IPC.sidecarInstallProgress, h)
    }
  },
  routerModels: {
    status: () => bridge.invoke(IPC.routerModelsStatus),
    installNodeRuntime: () => bridge.invoke(IPC.routerModelsInstallNodeRuntime),
    setupPython: () => bridge.invoke(IPC.routerModelsSetupPython),
    build: (role: 'embedding' | 'reranker') => bridge.invoke(IPC.routerModelsBuild, role),
    remove: (role: 'embedding' | 'reranker') => bridge.invoke(IPC.routerModelsRemove, role),
    onBuildProgress: (
      cb: (e: { phase: string; detail: string; percent?: number }) => void
    ) => {
      const h = (_: unknown, p: { phase: string; detail: string; percent?: number }) => cb(p)
      bridge.on(IPC.routerModelsBuildProgress, h)
      return () => bridge.removeListener(IPC.routerModelsBuildProgress, h)
    }
  },
  gpu: {
    list: (force?: boolean): Promise<GpuDevice[]> => bridge.invoke(IPC.gpuList, force)
  },
  hf: {
    search: (opts: HFSearchOptions | string): Promise<HFSearchResult[]> =>
      bridge.invoke(IPC.hfSearch, opts),
    card: (repo: string): Promise<HFModelCard> => bridge.invoke(IPC.hfCard, repo),
    tags: (): Promise<string[]> => bridge.invoke(IPC.hfTags)
  },
  modelMeta: {
    inspect: (modelId: string): Promise<ModelMetadata> => bridge.invoke(IPC.modelInspect, modelId),
    estimate: (
      modelId: string,
      cfg: ModelConfig,
      gpuMb?: number,
      gpuBudgetMb?: number
    ): Promise<MemoryEstimate> =>
      bridge.invoke(IPC.modelEstimate, modelId, cfg, gpuMb, gpuBudgetMb),
    estimateFile: (
      sizeBytes: number,
      contextSize?: number,
      quant?: string
    ): Promise<{ weightsMb: number; kvCacheMb: number; vramMb: number; ramMbIfCpu: number }> =>
      bridge.invoke(IPC.modelEstimateFile, sizeBytes, contextSize, quant)
  },
  models: {
    list: (): Promise<ModelInfo[]> => bridge.invoke(IPC.modelsList),
    onInventoryChanged: (cb: () => void) => {
      const fn = () => {
        cb()
        window.dispatchEvent(new CustomEvent('omega:models-inventory-changed'))
      }
      bridge.on(IPC.modelsInventoryChanged, fn)
      return () => bridge.removeListener(IPC.modelsInventoryChanged, fn)
    },
    unload: (model: string) => bridge.invoke(IPC.modelsUnload, model),
    load: (model: string): Promise<{ activeModel: string; loaded: boolean; nativeLoaded: string | null }> =>
      bridge.invoke(IPC.modelsLoad, model),
    onLoadProgress: (
      cb: (p: { modelId: string; phase: string; detail?: string; percent?: number }) => void
    ) => {
      const fn = (_: unknown, p: { modelId: string; phase: string; detail?: string; percent?: number }) =>
        cb(p)
      bridge.on(IPC.modelsLoadProgress, fn)
      return () => bridge.removeListener(IPC.modelsLoadProgress, fn)
    },
    delete: (model: string) => bridge.invoke(IPC.modelsDelete, model),
    repoFiles: (repo: string) => bridge.invoke(IPC.modelsRepoFiles, repo),
    checkHfAccess: (repo: string) =>
      bridge.invoke(IPC.modelsCheckHfAccess, repo) as Promise<{
        ok: boolean
        status: number
        hasToken: boolean
        pageUrl: string
        gated: boolean
        hint: 'accept_license' | 'add_token' | 'refresh_token' | null
      }>,
    openHfRepo: async (repo: string) => {
      const pageUrl = hfRepoPageUrl(repo)
      requestOmegaBrowser(pageUrl)
      try {
        const result = (await bridge.invoke(IPC.modelsOpenHfRepo, repo)) as {
          opened?: boolean
          pageUrl?: string
        }
        return { opened: true, pageUrl: result.pageUrl || pageUrl }
      } catch {
        return { opened: true, pageUrl }
      }
    },
    download: (repo: string, filename: string) => bridge.invoke(IPC.modelsDownload, repo, filename),
    downloadRequired: (req: {
      repo: string
      files: import('@omega/sdk').HFFile[]
      primaryPath?: string
      visionPath?: string
      tags?: string[]
      format?: string
    }) => bridge.invoke(IPC.modelsDownloadRequired, req),
    cancelDownload: (repo: string, filename: string) =>
      bridge.invoke(IPC.modelsDownloadCancel, repo, filename),
    downloadAdapter: (repo: string, filename: string) =>
      bridge.invoke(IPC.modelsDownloadAdapter, repo, filename),
    onDownloadProgress: (cb: (p: unknown) => void) => {
      const fn = (_: unknown, p: unknown) => cb(p)
      bridge.on(IPC.downloadProgress, fn)
      return () => bridge.removeListener(IPC.downloadProgress, fn)
    },
    quantize: (req: QuantizeRequest) => bridge.invoke(IPC.modelsQuantize, req),
    onQuantizeProgress: (cb: (p: unknown) => void) => {
      const fn = (_: unknown, p: unknown) => cb(p)
      bridge.on(IPC.quantizeProgress, fn)
      return () => bridge.removeListener(IPC.quantizeProgress, fn)
    },
    benchmark: (model: string) => bridge.invoke(IPC.modelsBenchmark, model),
    footprint: (model: string) => bridge.invoke(IPC.modelsFootprint, model)
  },
  sessions: {
    list: () => bridge.invoke(IPC.sessionsList),
    search: (query: string) => bridge.invoke(IPC.sessionsSearch, query),
    messages: (sessionId: string) => bridge.invoke(IPC.sessionsMessages, sessionId),
    create: (title: string, modelId: string, systemPrompt: string) =>
      bridge.invoke(IPC.sessionsCreate, title, modelId, systemPrompt),
    delete: (id: string) => bridge.invoke(IPC.sessionsDelete, id),
    updateTitle: (id: string, title: string) => bridge.invoke(IPC.sessionsUpdateTitle, id, title),
    updateModel: (id: string, modelId: string): Promise<{ ok: boolean; modelId?: string }> =>
      bridge.invoke(IPC.sessionsUpdateModel, id, modelId),
    fork: (id: string) => bridge.invoke(IPC.sessionsFork, id) as Promise<{ id: string; title: string }>,
    truncate: (id: string, fromIndex: number) => bridge.invoke(IPC.sessionsTruncate, id, fromIndex),
    contextBuffer: (sessionId: string, modelId: string): Promise<ContextBufferState> =>
      bridge.invoke(IPC.contextBuffer, sessionId, modelId)
  },
  memory: {
    list: (): Promise<MemoryEntry[]> => bridge.invoke(IPC.memoryList),
    add: (kind: string, content: string, sessionId?: string) =>
      bridge.invoke(IPC.memoryAdd, kind, content, sessionId),
    delete: (id: string) => bridge.invoke(IPC.memoryDelete, id),
    search: (q: string) => bridge.invoke(IPC.memorySearch, q),
    graph: (runId?: string): Promise<DecisionNode[]> => bridge.invoke(IPC.memoryGraph, runId),
    projectContext: (sessionId?: string) =>
      bridge.invoke(IPC.memoryProjectContext, sessionId) as Promise<
        import('@omega/sdk').ProjectMemoryContext
      >,
    exportBundle: () =>
      bridge.invoke(IPC.memoryExport) as Promise<import('@omega/sdk').MemoryBundle>,
    importBundle: (bundle: import('@omega/sdk').MemoryBundle, mode?: 'merge' | 'replace') =>
      bridge.invoke(IPC.memoryImport, bundle, mode) as Promise<{ imported: number; skipped: number }>,
    runJanitor: () =>
      bridge.invoke(IPC.memoryJanitorRun) as Promise<{ memoryRemoved: number; note: string }>
  },
  project: {
    openFolder: (sessionId: string) =>
      bridge.invoke(IPC.projectOpenFolder, sessionId) as Promise<{
        ok: boolean
        path: string
        error?: string
      }>,
    listFiles: (sessionId: string) =>
      bridge.invoke(IPC.projectListFiles, sessionId) as Promise<
        Array<{ sub: string; name: string; path: string }>
      >
  },
  tools: {
    list: (): Promise<ToolInfo[]> => bridge.invoke(IPC.toolsList),
    toggle: (name: string, enabled: boolean) => bridge.invoke(IPC.toolsToggle, name, enabled),
    run: (name: string, args: Record<string, string>) => bridge.invoke(IPC.toolsRun, name, args),
    onApproveRequest: (cb: (req: ToolApprovalRequest) => void) => {
      const fn = (_: unknown, p: ToolApprovalRequest) => cb(p)
      bridge.on(IPC.toolApproveRequest, fn)
      return () => bridge.removeListener(IPC.toolApproveRequest, fn)
    },
    approve: async (id: string, approved: boolean) => {
      const res = (await bridge.invoke(IPC.toolApproveResolve, id, approved)) as {
        status?: string
      }
      if (res?.status === 'expired') {
        throw new Error('approval expired')
      }
    }
  },
  plugins: {
    list: (): Promise<PluginInfo[]> => bridge.invoke(IPC.pluginsList),
    toggle: (id: string, enabled: boolean) => bridge.invoke(IPC.pluginsToggle, id, enabled),
    reload: () => bridge.invoke(IPC.pluginsReload)
  },
  workflows: {
    list: (): Promise<Workflow[]> => bridge.invoke(IPC.workflowsList),
    get: (id: string): Promise<Workflow | undefined> => bridge.invoke(IPC.workflowsGet, id),
    save: (wf: Omit<Workflow, 'updatedAt'>): Promise<Workflow> => bridge.invoke(IPC.workflowsSave, wf),
    delete: (id: string) => bridge.invoke(IPC.workflowsDelete, id),
    run: (id: string, vars: Record<string, string>, model: string): Promise<WorkflowRunResult> =>
      bridge.invoke(IPC.workflowsRun, id, vars, model),
    abort: (runId?: string) => bridge.invoke(IPC.workflowsAbort, runId),
    onEvent: (cb: (e: WorkflowRunEvent) => void) => {
      const fn = (_: unknown, e: WorkflowRunEvent) => cb(e)
      bridge.on(IPC.workflowsEvent, fn)
      return () => bridge.removeListener(IPC.workflowsEvent, fn)
    }
  },
  inputPipelines: {
    list: (): Promise<import('@omega/sdk').InputPipeline[]> =>
      bridge.invoke(IPC.inputPipelinesList),
    get: (id: string): Promise<import('@omega/sdk').InputPipeline | undefined> =>
      bridge.invoke(IPC.inputPipelinesGet, id),
    save: (
      row: Omit<import('@omega/sdk').InputPipeline, 'updatedAt'>
    ): Promise<import('@omega/sdk').InputPipeline> => bridge.invoke(IPC.inputPipelinesSave, row),
    delete: (id: string) => bridge.invoke(IPC.inputPipelinesDelete, id),
    setActive: (scope: import('@omega/sdk').InputPipelineScope, id: string) =>
      bridge.invoke(IPC.inputPipelinesSetActive, scope, id)
  },
  skills: {
    list: (): Promise<Skill[]> => bridge.invoke(IPC.skillsList),
    get: (id: string): Promise<SkillContent | null> => bridge.invoke(IPC.skillsGet, id),
    save: (input: {
      id?: string
      name: string
      description: string
      category?: string
      tags?: string[]
      enabled?: boolean
      body: string
    }): Promise<SkillContent> => bridge.invoke(IPC.skillsSave, input),
    delete: (id: string) => bridge.invoke(IPC.skillsDelete, id),
    toggle: (id: string, enabled: boolean): Promise<SkillContent | null> =>
      bridge.invoke(IPC.skillsToggle, id, enabled)
  },
  profiles: {
    list: (): Promise<Profile[]> => bridge.invoke(IPC.profilesList),
    create: (id: string, cloneFrom?: string): Promise<Profile> =>
      bridge.invoke(IPC.profilesCreate, id, cloneFrom),
    switch: (id: string): Promise<Profile> => bridge.invoke(IPC.profilesSwitch, id),
    delete: (id: string) => bridge.invoke(IPC.profilesDelete, id)
  },
  soul: {
    get: (): Promise<Soul> => bridge.invoke(IPC.soulGet),
    set: (s: Soul): Promise<Soul> => bridge.invoke(IPC.soulSet, s),
    reset: (): Promise<Soul> => bridge.invoke(IPC.soulReset)
  },
  orchestratorPrompts: {
    getDefaults: (): Promise<import('@omega/sdk').OrchestratorPromptDefaults> =>
      bridge.invoke(IPC.orchestratorPromptsDefaults)
  },
  cron: {
    list: (): Promise<CronJob[]> => bridge.invoke(IPC.cronList),
    save: (job: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt'> & { id?: string }): Promise<CronJob> =>
      bridge.invoke(IPC.cronSave, job),
    delete: (id: string) => bridge.invoke(IPC.cronDelete, id),
    pause: (id: string, paused: boolean): Promise<CronJob | undefined> =>
      bridge.invoke(IPC.cronPause, id, paused),
    runNow: (id: string): Promise<CronJob | undefined> => bridge.invoke(IPC.cronRunNow, id),
    onChange: (cb: (jobs: CronJob[]) => void) => {
      const fn = (_: unknown, j: CronJob[]) => cb(j)
      bridge.on(IPC.cronChanged, fn)
      return () => bridge.removeListener(IPC.cronChanged, fn)
    }
  },
  kanban: {
    list: (): Promise<KanbanTask[]> => bridge.invoke(IPC.kanbanList),
    save: (task: Partial<KanbanTask> & { title: string }): Promise<KanbanTask> =>
      bridge.invoke(IPC.kanbanSave, task),
    move: (id: string, status: KanbanStatus): Promise<KanbanTask | undefined> =>
      bridge.invoke(IPC.kanbanMove, id, status),
    delete: (id: string) => bridge.invoke(IPC.kanbanDelete, id),
    dispatch: (id?: string): Promise<KanbanTask | null> =>
      bridge.invoke(IPC.kanbanDispatch, id),
    onChange: (cb: (tasks: KanbanTask[]) => void) => {
      const fn = (_: unknown, t: KanbanTask[]) => cb(t)
      bridge.on(IPC.kanbanChanged, fn)
      return () => bridge.removeListener(IPC.kanbanChanged, fn)
    }
  },
  mcp: {
    list: (): Promise<McpServerConfig[]> => bridge.invoke(IPC.mcpList),
    save: (s: McpServerConfig): Promise<McpServerConfig> => bridge.invoke(IPC.mcpSave, s),
    delete: (id: string) => bridge.invoke(IPC.mcpDelete, id),
    start: (id: string): Promise<McpServerStatus | null> => bridge.invoke(IPC.mcpStart, id),
    stop: (id: string) => bridge.invoke(IPC.mcpStop, id),
    status: (): Promise<McpServerStatus[]> => bridge.invoke(IPC.mcpStatus),
    onStatus: (cb: (s: McpServerStatus[]) => void) => {
      const fn = (_: unknown, s: McpServerStatus[]) => cb(s)
      bridge.on(IPC.mcpStatusChanged, fn)
      return () => bridge.removeListener(IPC.mcpStatusChanged, fn)
    }
  },
  providers: {
    list: (): Promise<RemoteProvider[]> => bridge.invoke(IPC.providersList),
    save: (p: RemoteProvider): Promise<RemoteProvider> => bridge.invoke(IPC.providersSave, p),
    delete: (id: string) => bridge.invoke(IPC.providersDelete, id),
    presets: (): Promise<RemoteProvider[]> => bridge.invoke(IPC.providersPresets),
    discover: (): Promise<Array<{ providerId: string; modelId: string; displayName: string }>> =>
      bridge.invoke(IPC.providersDiscover),
    fetchModels: (req: {
      id: string
      persist?: boolean
      apiKey?: string
      baseUrl?: string
      kind?: string
    }): Promise<{ models: string[]; error?: string }> =>
      bridge.invoke(IPC.providersFetchModels, req),
    onChanged: (cb: () => void) => {
      const fn = () => cb()
      bridge.on(IPC.providersChanged, fn)
      return () => bridge.removeListener(IPC.providersChanged, fn)
    }
  },
  gateway: {
    platforms: (): Promise<Array<{
      id: GatewayPlatformId
      label: string
      group: string
      implemented: boolean
      fields: Array<{ name: string; label: string; type?: 'text' | 'password' | 'url' }>
    }>> => bridge.invoke(IPC.gatewayPlatforms),
    list: (): Promise<GatewayPlatformConfig[]> => bridge.invoke(IPC.gatewayList),
    save: (c: GatewayPlatformConfig): Promise<GatewayPlatformConfig> =>
      bridge.invoke(IPC.gatewaySave, c),
    delete: (id: GatewayPlatformId) => bridge.invoke(IPC.gatewayDelete, id),
    start: (id: GatewayPlatformId): Promise<GatewayStatus | null> =>
      bridge.invoke(IPC.gatewayStart, id),
    stop: (id: GatewayPlatformId) => bridge.invoke(IPC.gatewayStop, id),
    status: (): Promise<GatewayStatus[]> => bridge.invoke(IPC.gatewayStatus),
    onStatus: (cb: (s: GatewayStatus[]) => void) => {
      const fn = (_: unknown, s: GatewayStatus[]) => cb(s)
      bridge.on(IPC.gatewayStatusChanged, fn)
      return () => bridge.removeListener(IPC.gatewayStatusChanged, fn)
    }
  },
  pluginStore: {
    catalog: (): Promise<PluginCatalogEntry[]> => bridge.invoke(IPC.pluginsCatalog),
    installBuiltin: (id: string): Promise<PluginManifest> => bridge.invoke(IPC.pluginsInstallBuiltin, id),
    installUrl: (url: string): Promise<PluginManifest> => bridge.invoke(IPC.pluginsInstallUrl, url),
    uninstall: (id: string) => bridge.invoke(IPC.pluginsUninstall, id)
  },
  rag: {
    list: (): Promise<RagSource[]> => bridge.invoke(IPC.ragList),
    indexFile: (path: string): Promise<number> => bridge.invoke(IPC.ragIndexFile, path),
    indexDir: (path: string): Promise<{ files: number; chunks: number }> =>
      bridge.invoke(IPC.ragIndexDir, path),
    clear: (source?: string) => bridge.invoke(IPC.ragClear, source),
    search: (query: string): Promise<RagHit[]> => bridge.invoke(IPC.ragSearch, query)
  },
  chat: {
    send: (req: ChatRequest & { streamId: string; sessionId?: string }) => bridge.invoke(IPC.chatSend, req),
    abort: (streamId: string) => bridge.invoke(IPC.chatAbort, streamId),
    pickAttachments: (): Promise<string[]> => bridge.invoke(IPC.chatPickAttachments),
    stageAttachment: (sessionId: string, sourcePath: string) =>
      bridge.invoke(IPC.chatStageAttachment, sessionId, sourcePath),
    stageAttachmentData: (
      sessionId: string,
      name: string,
      dataBase64: string,
      mime?: string
    ) => bridge.invoke(IPC.chatStageAttachment, { sessionId, name, data: dataBase64, mime }),
    attachmentLimits: (): Promise<{ maxBytes: number; maxCount: number }> =>
      bridge.invoke(IPC.chatAttachmentLimits),
    onToken: (cb: (p: { streamId: string; token: Token }) => void) => {
      const fn = (_: unknown, p: { streamId: string; token: Token }) => cb(p)
      bridge.on(IPC.streamToken, fn)
      return () => bridge.removeListener(IPC.streamToken, fn)
    },
    onMetrics: (cb: (p: { streamId: string; metrics: import('@omega/sdk').InferenceMetricsSnapshot }) => void) => {
      const fn = (_: unknown, p: { streamId: string; metrics: import('@omega/sdk').InferenceMetricsSnapshot }) =>
        cb(p)
      bridge.on(IPC.streamMetrics, fn)
      return () => bridge.removeListener(IPC.streamMetrics, fn)
    },
    onDone: (cb: (p: { streamId: string; result: GenerateResult }) => void) => {
      const fn = (_: unknown, p: { streamId: string; result: GenerateResult }) => cb(p)
      bridge.on(IPC.streamDone, fn)
      return () => bridge.removeListener(IPC.streamDone, fn)
    },
    onError: (cb: (p: { streamId: string; error: string }) => void) => {
      const fn = (_: unknown, p: { streamId: string; error: string }) => cb(p)
      bridge.on(IPC.streamError, fn)
      return () => bridge.removeListener(IPC.streamError, fn)
    },
    onMedia: (cb: (p: { streamId: string; part: import('@omega/sdk').MessagePart }) => void) => {
      const fn = (_: unknown, p: { streamId: string; part: import('@omega/sdk').MessagePart }) => cb(p)
      bridge.on(IPC.streamMedia, fn)
      return () => bridge.removeListener(IPC.streamMedia, fn)
    },
    onSessionMessage: (
      cb: (p: { sessionId: string; message: import('@omega/sdk').Message }) => void
    ) => {
      const fn = (_: unknown, p: { sessionId: string; message: import('@omega/sdk').Message }) => cb(p)
      bridge.on(IPC.sessionMessageAppended, fn)
      return () => bridge.removeListener(IPC.sessionMessageAppended, fn)
    },
    onSessionAssistantPatch: (
      cb: (p: {
        sessionId: string
        content?: string
        parts: import('@omega/sdk').MessagePart[]
        jobId?: string
        messageIndex?: number
      }) => void
    ) => {
      const fn = (
        _: unknown,
        p: {
          sessionId: string
          content?: string
          parts: import('@omega/sdk').MessagePart[]
          jobId?: string
          messageIndex?: number
        }
      ) => cb(p)
      bridge.on(IPC.sessionAssistantPatch, fn)
      return () => bridge.removeListener(IPC.sessionAssistantPatch, fn)
    }
  },
  pipeline: {
    get: (): Promise<import('../shared/pipeline-activity').PipelineActivity> =>
      bridge.invoke(IPC.pipelineActivityGet),
    onChanged: (cb: (a: import('../shared/pipeline-activity').PipelineActivity) => void) => {
      const fn = (_: unknown, a: import('../shared/pipeline-activity').PipelineActivity) => cb(a)
      bridge.on(IPC.pipelineActivityChanged, fn)
      return () => bridge.removeListener(IPC.pipelineActivityChanged, fn)
    }
  },
  agent: {
    run: (req: AgentRunRequest): Promise<AgentRunResult> => bridge.invoke(IPC.agentRun, req),
    abort: (): Promise<void> => bridge.invoke(IPC.agentAbort),
    onStep: (cb: (step: AgentStep) => void) => {
      const fn = (_: unknown, step: AgentStep) => cb(step)
      bridge.on(IPC.agentStep, fn)
      return () => bridge.removeListener(IPC.agentStep, fn)
    },
    onToken: (cb: (token: Token) => void) => {
      const fn = (_: unknown, token: Token) => cb(token)
      bridge.on(IPC.agentToken, fn)
      return () => bridge.removeListener(IPC.agentToken, fn)
    }
  },
  debug: {
    history: (): Promise<DebugEvent[]> => bridge.invoke(IPC.debugHistory),
    onEvent: (cb: (e: DebugEvent) => void) => {
      const fn = (_: unknown, e: DebugEvent) => cb(e)
      bridge.on(IPC.debugSubscribe, fn)
      return () => bridge.removeListener(IPC.debugSubscribe, fn)
    }
  },
  python: {
    status: (): Promise<{
      venv_path: string
      python_path: string
      venv_present: boolean
      setup_running: boolean
      setup_engine?: string
      profile?: Record<string, unknown>
    }> => bridge.invoke(IPC.pythonStatus),
    setup: (opts?: { profile?: 'base' | 'content' | 'full' }): Promise<void> =>
      bridge.invoke(IPC.pythonSetup, opts ?? {})
  },
  contentStudio: {
    status: (): Promise<ContentStudioStatus> => bridge.invoke(IPC.contentStudioStatus),
    setupEnvironment: (opts?: { profile?: 'content' | 'content-media' }): Promise<void> =>
      bridge.invoke(IPC.contentStudioSetupEnvironment, opts),
    onSetupProgress: (cb: (p: ContentStudioSetupProgress) => void) => {
      const fn = (_: unknown, p: ContentStudioSetupProgress) => cb(p)
      bridge.on(IPC.contentStudioSetupProgress, fn)
      return () => bridge.removeListener(IPC.contentStudioSetupProgress, fn)
    },
    onChanged: (cb: () => void) => {
      const fn = () => {
        cb()
        window.dispatchEvent(new CustomEvent('omega:content-studio-changed'))
      }
      bridge.on(IPC.contentStudioChanged, fn)
      return () => bridge.removeListener(IPC.contentStudioChanged, fn)
    },
    start: (): Promise<void> => bridge.invoke(IPC.contentStudioStart),
    stop: (): Promise<void> => bridge.invoke(IPC.contentStudioStop),
    restart: (): Promise<void> => bridge.invoke(IPC.contentStudioRestart),
    listProjects: (): Promise<ContentStudioProject[]> =>
      bridge.invoke(IPC.contentStudioProjects),
    createRun: (body: {
      title?: string
      theme?: string
      project_id?: string
      pipeline_mode?: string
      episode_topic?: string
    }): Promise<ContentStudioRun> => bridge.invoke(IPC.contentStudioCreateRun, body),
    runStatus: (jobId: string): Promise<ContentStudioRunStatus> =>
      bridge.invoke(IPC.contentStudioRunStatus, jobId),
    forceStopJob: (body: {
      sessionId?: string
      jobId: string
      projectId?: string
      title?: string | null
    }): Promise<{ ok: boolean; message: string; phase?: 'stopping' | 'cancelled' }> =>
      bridge.invoke(IPC.contentStudioForceStopJob, body),
    listSchedules: (): Promise<ContentSchedule[]> => bridge.invoke(IPC.contentStudioSchedules),
    createSchedule: (body: {
      project_id?: string
      series_id?: string
      cron_expression: string
      timezone?: string
    }): Promise<ContentSchedule> => bridge.invoke(IPC.contentStudioScheduleCreate, body),
    scheduleDelete: (id: string): Promise<void> =>
      bridge.invoke(IPC.contentStudioScheduleDelete, id),
    socialPlatforms: (): Promise<ContentSocialPlatform[]> =>
      bridge.invoke(IPC.contentStudioSocialPlatforms),
    socialAccounts: (): Promise<ContentSocialAccount[]> =>
      bridge.invoke(IPC.contentStudioSocialAccounts),
    socialPosts: (): Promise<ContentSocialPost[]> => bridge.invoke(IPC.contentStudioSocialPosts),
    socialPublish: (body: {
      platform: string
      title: string
      caption?: string
      project_id?: string
      publish_now?: boolean
    }): Promise<ContentSocialPost> => bridge.invoke(IPC.contentStudioSocialPublish, body),
    credentials: {
      get: (): Promise<ContentStudioCredentials> =>
        bridge.invoke(IPC.contentStudioCredentialsGet),
      set: (creds: ContentStudioCredentials): Promise<ContentStudioCredentials> =>
        bridge.invoke(IPC.contentStudioCredentialsSet, creds),
      sync: (): Promise<{ platforms: Record<string, boolean> }> =>
        bridge.invoke(IPC.contentStudioCredentialsSync),
      status: (): Promise<Record<string, boolean>> =>
        bridge.invoke(IPC.contentStudioCredentialsStatus)
    },
    youtube: {
      connect: (): Promise<{ refreshToken: string }> =>
        bridge.invoke(IPC.contentStudioYoutubeConnect)
    },
    listSeries: (): Promise<ContentSeries[]> => bridge.invoke(IPC.contentStudioSeriesList),
    createSeries: (body: {
      title: string
      theme: string
      default_max_duration_seconds?: number
    }): Promise<ContentSeries> => bridge.invoke(IPC.contentStudioSeriesCreate, body),
    deleteSeries: (id: string): Promise<void> =>
      bridge.invoke(IPC.contentStudioSeriesDelete, id),
    generation: {
      get: (): Promise<ContentStudioGenerationSettings> =>
        bridge.invoke(IPC.contentStudioGenerationGet),
      set: (settings: ContentStudioGenerationSettings): Promise<ContentStudioGenerationSettings> =>
        bridge.invoke(IPC.contentStudioGenerationSet, settings),
      catalog: (): Promise<ContentGenerationCatalog> =>
        bridge.invoke(IPC.contentStudioGenerationCatalog),
      capabilities: (
        modality: 'tts' | 'image' | 'video',
        repoId: string
      ): Promise<GenerationCapabilities> =>
        bridge.invoke(IPC.contentStudioGenerationCapabilities, modality, repoId),
      downloadModel: (
        kind: 'tts' | 'image' | 'video' | 'image_adapter',
        repoId: string,
        label?: string,
        sizeHint?: string
      ): Promise<{
        dest: string
        repoId: string
        kind: 'tts' | 'image' | 'video' | 'image_adapter'
      }> =>
        bridge.invoke(IPC.contentStudioGenerationDownload, kind, repoId, label, sizeHint),
      nativeRender: (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
        bridge.invoke(IPC.contentStudioNativeRender, body)
    }
  },
  finetune: {
    analyze: (modelId: string): Promise<FinetuneModelProfile> =>
      bridge.invoke(IPC.finetuneAnalyze, modelId),
    prepareDataset: (req: FinetunePrepareDatasetRequest) =>
      bridge.invoke(IPC.finetunePrepareDataset, req),
    list: (): Promise<FinetuneJob[]> => bridge.invoke(IPC.finetuneList),
    get: (id: string): Promise<FinetuneJob | undefined> => bridge.invoke(IPC.finetuneGet, id),
    create: (req: FinetuneStartRequest): Promise<FinetuneJob> =>
      bridge.invoke(IPC.finetuneCreate, req),
    start: (jobId: string): Promise<FinetuneJob> => bridge.invoke(IPC.finetuneStart, jobId),
    abort: (jobId: string): Promise<void> => bridge.invoke(IPC.finetuneAbort, jobId),
    delete: (jobId: string): Promise<void> => bridge.invoke(IPC.finetuneDelete, jobId),
    onProgress: (cb: (p: FinetuneProgress) => void): (() => void) => {
      const fn = (_: unknown, p: FinetuneProgress) => cb(p)
      bridge.on(IPC.finetuneProgress, fn)
      return () => bridge.removeListener(IPC.finetuneProgress, fn)
    },
    listDatasets: (): Promise<FinetuneDatasetEntry[]> =>
      bridge.invoke(IPC.finetuneListDatasets),
    listPresets: (): Promise<FinetuneDatasetPreset[]> => bridge.invoke(IPC.finetuneListPresets),
    savePreset: (input: {
      name: string
      sources: string[]
      modality: FinetuneModality
      format?: FinetuneDatasetPreset['format']
    }): Promise<FinetuneDatasetPreset> => bridge.invoke(IPC.finetuneSavePreset, input),
    deletePreset: (id: string): Promise<void> => bridge.invoke(IPC.finetuneDeletePreset, id),
    inspectSource: (path: string): Promise<FinetuneSourceInspect> =>
      bridge.invoke(IPC.finetuneInspectSource, path),
    pickSources: (): Promise<string[]> => bridge.invoke(IPC.finetunePickSources),
    datasetsRoot: (): Promise<string> => bridge.invoke(IPC.finetuneDatasetsRoot),
    deletePrepared: (id: string): Promise<boolean> =>
      bridge.invoke(IPC.finetuneDeletePrepared, id)
  },
  editor: {
    read: (filePath: string): Promise<string> => bridge.invoke(IPC.editorRead, filePath),
    write: (filePath: string, content: string): Promise<void> =>
      bridge.invoke(IPC.editorWrite, filePath, content),
    openFiles: (): Promise<
      Array<{ path: string; content: string; language: string; title: string }>
    > => bridge.invoke(IPC.editorOpenFiles),
    saveAs: (content: string, suggestedPath?: string): Promise<string | null> =>
      bridge.invoke(IPC.editorSaveAs, content, suggestedPath),
    deleteFile: (filePath: string): Promise<void> => bridge.invoke(IPC.editorDeleteFile, filePath)
  },
  terminal: {
    history: (): Promise<TerminalLine[]> => bridge.invoke(IPC.terminalHistory),
    clear: (): Promise<void> => bridge.invoke(IPC.terminalClear),
    runSnippet: (opts: {
      lang: string
      code: string
      path?: string
      suggestedName?: string
      /** User-typed command in the chat terminal (does not require agent allowShell). */
      source?: 'terminal' | 'snippet'
      sessionId?: string
    }): Promise<{ ok: boolean; error?: string; output?: string; script?: string }> =>
      bridge.invoke(IPC.terminalRunSnippet, opts),
    runCommand: (
      command: string,
      opts?: { sessionId?: string }
    ): Promise<{ ok: boolean; error?: string; output?: string }> =>
      bridge.invoke(IPC.terminalRunSnippet, {
        lang: 'shell',
        code: command,
        source: 'terminal',
        sessionId: opts?.sessionId
      }),
    saveSnippet: (content: string, suggestedName: string): Promise<string | null> =>
      bridge.invoke(IPC.terminalSaveSnippet, { content, suggestedName }),
    onLine: (cb: (line: TerminalLine) => void): (() => void) => {
      const fn = (_: unknown, line: TerminalLine) => cb(line)
      bridge.on(IPC.terminalLine, fn)
      return () => bridge.removeListener(IPC.terminalLine, fn)
    }
  },
  browser: {
    show: (bounds: BrowserBounds, mode?: 'mini' | 'full'): Promise<void> =>
      bridge.invoke(IPC.browserShow, bounds, mode ?? 'full'),
    hide: (): Promise<void> => bridge.invoke(IPC.browserHide),
    mediaCommand: (cmd: { action: 'stop' | 'pause' | 'resume' | 'play' }): Promise<{ ok?: boolean }> =>
      bridge.invoke(IPC.browserMediaCommand, cmd),
    setBounds: (bounds: BrowserBounds): Promise<void> =>
      bridge.invoke(IPC.browserSetBounds, bounds),
    navigate: (url: string): Promise<BrowserStatus> => bridge.invoke(IPC.browserNavigate, url),
    back: (): Promise<BrowserStatus | null> => bridge.invoke(IPC.browserBack),
    forward: (): Promise<BrowserStatus | null> => bridge.invoke(IPC.browserForward),
    reload: (): Promise<BrowserStatus | null> => bridge.invoke(IPC.browserReload),
    getStatus: (): Promise<BrowserStatus | null> => bridge.invoke(IPC.browserGetStatus),
    info: (): Promise<{ available: boolean; error?: string }> => bridge.invoke(IPC.browserInfo),
    onStatus: (cb: (s: BrowserStatus) => void): (() => void) => {
      const fn = (_: unknown, s: BrowserStatus) => cb(s)
      bridge.on(IPC.browserStatus, fn)
      return () => bridge.removeListener(IPC.browserStatus, fn)
    },
    onHidden: (cb: () => void): (() => void) => {
      const fn = () => cb()
      bridge.on(IPC.browserHidden, fn)
      return () => bridge.removeListener(IPC.browserHidden, fn)
    }
  },
  shortcuts: {
    /** Subscribe to application-menu accelerators (Ctrl+N, Ctrl+L, Ctrl+1..9, …). */
    on: (cb: (e: { action: string; page?: string }) => void): (() => void) => {
      const fn = (_: unknown, e: { action: string; page?: string }): void => cb(e)
      bridge.on('omega:shortcut', fn)
      return () => bridge.removeListener('omega:shortcut', fn)
    }
  },
  companion: {
    setActiveChat: (state: {
      sessionId: string | null
      modelId: string
      systemPrompt: string
    }): void => bridge.send(IPC.companionSetActiveChat, state),
    getActiveChat: (): Promise<{
      sessionId: string | null
      modelId: string
      systemPrompt: string
    }> => bridge.invoke(IPC.companionGetActiveChat),
    sendToMainChat: (detail: {
      text: string
      attachments?: import('@omega/sdk').MediaRef[]
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      bridge.invoke(IPC.companionSendToMain, detail),
    onSendDeliver: (
      cb: (detail: { text: string; attachments?: import('@omega/sdk').MediaRef[] }) => void
    ): (() => void) => {
      const fn = (_: unknown, detail: unknown): void => {
        if (typeof detail === 'string') {
          try {
            const parsed = JSON.parse(detail) as {
              text: string
              attachments?: import('@omega/sdk').MediaRef[]
            }
            cb(parsed)
            return
          } catch {
            return
          }
        }
        if (detail && typeof detail === 'object') {
          cb(detail as { text: string; attachments?: import('@omega/sdk').MediaRef[] })
        }
      }
      bridge.on(IPC.companionSendDeliver, fn)
      return () => bridge.removeListener(IPC.companionSendDeliver, fn)
    },
    broadcastReply: (payload: {
      userText?: string
      assistantText: string
      done: boolean
      error?: string
    }): void => bridge.send(IPC.companionReplyBroadcast, payload),
    onReplyDeliver: (
      cb: (payload: {
        userText?: string
        assistantText: string
        done: boolean
        error?: string
      }) => void
    ): (() => void) => {
      const fn = (
        _: unknown,
        payload: {
          userText?: string
          assistantText: string
          done: boolean
          error?: string
        }
      ): void => cb(payload)
      bridge.on(IPC.companionReplyDeliver, fn)
      return () => bridge.removeListener(IPC.companionReplyDeliver, fn)
    }
  },
  avatarMonitor: {
    setEnabled: (
      enabled: boolean,
      state?: { x?: number; y?: number; collapsed?: boolean; scale?: number }
    ): Promise<{ enabled: boolean }> =>
      bridge.invoke(IPC.avatarMonitorSetEnabled, enabled, state),
    getEnabled: (): Promise<{ enabled: boolean }> => bridge.invoke(IPC.avatarMonitorGetEnabled),
    pushSignals: (signals: {
      speaking: number
      listening: number
      state: 'idle' | 'thinking' | 'speaking' | 'error'
    }): void => bridge.send(IPC.avatarMonitorSignals, signals),
    syncLayout: (layout: {
      collapsed: boolean
      scale?: number
      x?: number
      y?: number
      animationStyle?: 'neural_mesh' | 'matrix_layers' | 'spider_web'
    }): void => bridge.send(IPC.avatarMonitorSyncLayout, layout),
    setOverlayVisible: (visible: boolean): Promise<{ ok: boolean; overlayVisible?: boolean }> =>
      bridge.invoke(IPC.avatarMonitorSetOverlayVisible, { visible }),
    restoreMain: (): Promise<boolean> => bridge.invoke(IPC.avatarMonitorRestoreMain),
    onSignals: (
      cb: (s: {
        speaking: number
        listening: number
        state: 'idle' | 'thinking' | 'speaking' | 'error'
      }) => void
    ): (() => void) => {
      const fn = (_: unknown, payload: unknown): void => {
        const s = parseAvatarMonitorSignalsPayload(payload)
        if (s) cb(s)
      }
      bridge.on(IPC.avatarMonitorSignals, fn)
      return () => bridge.removeListener(IPC.avatarMonitorSignals, fn)
    },
    onEnabled: (cb: (enabled: boolean) => void): (() => void) => {
      const fn = (_: unknown, payload: unknown): void => cb(parseAvatarMonitorEnabledPayload(payload))
      bridge.on(IPC.avatarMonitorEnabled, fn)
      return () => bridge.removeListener(IPC.avatarMonitorEnabled, fn)
    },
    onLayout: (
      cb: (layout: {
        x: number
        y: number
        collapsed: boolean
        scale?: number
        animationStyle?: 'neural_mesh' | 'matrix_layers' | 'spider_web'
      }) => void
    ): (() => void) => {
      const fn = (_: unknown, payload: unknown): void => {
        const layout = parseAvatarMonitorLayoutPayload(payload)
        if (layout) cb(layout)
      }
      bridge.on(IPC.avatarMonitorLayout, fn)
      return () => bridge.removeListener(IPC.avatarMonitorLayout, fn)
    }
  },
  usage: {
    summary: (sessionId?: string) => bridge.invoke(IPC.usageSummary, sessionId)
  },
  workforce: {
    agents: () => bridge.invoke(IPC.workforceAgents),
    runs: () => bridge.invoke(IPC.workforceRuns),
    delegate: (agentId: string, task: string) =>
      bridge.invoke(IPC.workforceDelegate, agentId, task),
    runMoA: (task: string) => bridge.invoke(IPC.workforceMoA, task),
    runParallel: (tasks: Array<{ agentId: string; task: string }>) =>
      bridge.invoke(IPC.workforceParallel, tasks) as Promise<string[]>,
    setStandup: (active: boolean) => bridge.invoke(IPC.workforceStandup, active)
  },
  office: {
    snapshot: () => bridge.invoke(IPC.officeSnapshot),
    addMonitor: (body: {
      title: string
      kind: 'pr' | 'task' | 'log' | 'standup' | 'jira'
      summary: string
      url?: string
    }) => bridge.invoke(IPC.officeAddMonitor, body) as Promise<import('@omega/sdk').OfficeMonitor>,
    refreshMonitor: (monitorId: string) =>
      bridge.invoke(IPC.officeRefreshMonitor, monitorId) as Promise<
        import('@omega/sdk').OfficeMonitor | null
      >,
    fetchPr: (url: string) =>
      bridge.invoke(IPC.officeFetchPr, url) as Promise<import('@omega/sdk').PrMonitorData>,
    prComment: (owner: string, repo: string, number: number, body: string) =>
      bridge.invoke(IPC.officePrComment, owner, repo, number, body),
    prReview: (
      owner: string,
      repo: string,
      number: number,
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      body?: string
    ) => bridge.invoke(IPC.officePrReview, owner, repo, number, event, body),
    jiraComment: (issueKey: string, text: string) =>
      bridge.invoke(IPC.officeJiraComment, issueKey, text),
    pollSet: (enabled: boolean, intervalMs?: number) =>
      bridge.invoke(IPC.officePollSet, enabled, intervalMs) as Promise<
        import('@omega/sdk').OfficeSnapshot
      >,
    pollRefreshAll: () => bridge.invoke(IPC.officePollRefreshAll) as Promise<number>,
    skillGym: () => bridge.invoke(IPC.officeSkillGym) as Promise<string>,
    officeJanitor: () =>
      bridge.invoke(IPC.officeJanitor) as Promise<{ sessions: number; removed: number; note: string }>,
    kanbanPin: (taskId: string, pinned: boolean) =>
      bridge.invoke(IPC.officeKanbanPin, taskId, pinned) as Promise<
        import('@omega/sdk').OfficeSnapshot
      >,
    kanbanMonitor: (taskId: string) =>
      bridge.invoke(IPC.officeKanbanMonitor, taskId) as Promise<
        import('@omega/sdk').OfficeMonitor | null
      >,
    onChanged: (cb: (snap: import('@omega/sdk').OfficeSnapshot) => void): (() => void) => {
      const fn = (_: unknown, snap: import('@omega/sdk').OfficeSnapshot): void => cb(snap)
      bridge.on(IPC.officeChanged, fn)
      return () => bridge.removeListener(IPC.officeChanged, fn)
    },
    visualizationStatus: () =>
      bridge.invoke(IPC.officeVisualizationStatus) as Promise<
        import('@omega/sdk').OfficeVisualizationStatus
      >,
    visualizationSetup: () =>
      bridge.invoke(IPC.officeVisualizationSetup) as Promise<{
        ok: boolean
        error?: string
        log?: string
      }>,
    startVisualization: () =>
      bridge.invoke(IPC.officeVisualizationStart) as Promise<{
        success: boolean
        error?: string
        officeReady?: boolean
        gatewayReady?: boolean
      }>,
    stopVisualization: () => bridge.invoke(IPC.officeVisualizationStop)
  },
  selfImprove: {
    list: () => bridge.invoke(IPC.selfImproveList),
    reflect: (sessionId: string) => bridge.invoke(IPC.selfImproveReflect, sessionId),
    janitor: (sessionId: string) => bridge.invoke(IPC.selfImproveJanitor, sessionId)
  },
  media: {
    onState: (
      cb: (s: {
        kind: string
        title: string
        path?: string
        url?: string
        playing?: boolean
        embedInChat?: boolean
        previewType?: 'image' | 'video' | 'audio' | 'web' | 'file'
        sessionId?: string
        mediaRef?: string
      }) => void
    ) => {
      const h = (_: unknown, s: typeof cb extends (x: infer A) => void ? A : never) => cb(s)
      bridge.on(IPC.mediaState, h)
      return () => bridge.removeListener(IPC.mediaState, h)
    },
    pause: () => bridge.invoke(IPC.mediaPause),
    resume: () => bridge.invoke(IPC.mediaResume),
    stop: () => bridge.invoke(IPC.mediaStop),
    showPreview: (sessionId: string, part: import('@omega/sdk').MessagePart) =>
      bridge.invoke(IPC.mediaShowPreview, sessionId, part),
    reopenSessionVideo: (sessionId: string, jobId?: string) =>
      bridge.invoke(IPC.mediaReopenSessionVideo, sessionId, jobId) as Promise<{
        ok: boolean
        message: string
        ref?: string
      }>
  },
  voice: {
    onSpeak: (cb: (p: { text: string; mode: string }) => void) => {
      const h = (_: unknown, p: { text: string; mode: string }) => cb(p)
      bridge.on(IPC.voiceSpeak, h)
      return () => bridge.removeListener(IPC.voiceSpeak, h)
    }
  },
  assistant: {
    defaultPrompt: () => bridge.invoke(IPC.assistantDefaultPrompt) as Promise<string>
  },
  integrations: {
    get: () =>
      bridge.invoke(IPC.integrationsGet) as Promise<import('@omega/sdk').IntegrationsConfig>,
    set: (cfg: import('@omega/sdk').IntegrationsConfig) =>
      bridge.invoke(IPC.integrationsSet, cfg) as Promise<import('@omega/sdk').IntegrationsConfig>
  },
  screenSnip: {
    capture: (): Promise<import('../shared/screen-snip-types').ScreenSnipCaptureResult | null> =>
      bridge.invoke(IPC.screenSnipCapture),
    getBounds: (): Promise<import('../shared/screen-snip-types').VirtualDesktopBounds | null> =>
      bridge.invoke(IPC.screenSnipGetBounds),
    submit: (rect: import('../shared/screen-snip-types').ScreenSnipRect) =>
      bridge.invoke(IPC.screenSnipSubmit, rect),
    cancel: (): Promise<null> => bridge.invoke(IPC.screenSnipCancel),
    save: (tempPath: string): Promise<boolean> => bridge.invoke(IPC.screenSnipSave, tempPath),
    onInit: (cb: (bounds: import('../shared/screen-snip-types').VirtualDesktopBounds) => void) => {
      const fn = (_: unknown, bounds: import('../shared/screen-snip-types').VirtualDesktopBounds) =>
        cb(bounds)
      bridge.on(IPC.screenSnipInit, fn)
      return () => bridge.removeListener(IPC.screenSnipInit, fn)
    }
  },
  onContextFind: (cb: () => void): (() => void) => {
    const fn = () => cb()
    bridge.on(IPC.contextMenuFind, fn)
    return () => bridge.removeListener(IPC.contextMenuFind, fn)
  },
  onContextGotoLine: (cb: () => void): (() => void) => {
    const fn = () => cb()
    bridge.on(IPC.contextMenuGotoLine, fn)
    return () => bridge.removeListener(IPC.contextMenuGotoLine, fn)
  },
  updater: {
    status: () => bridge.invoke(IPC.updaterStatus),
    check: () => bridge.invoke(IPC.updaterCheck),
    install: () => bridge.invoke(IPC.updaterInstall),
    onStatus: (cb: (s: import('@omega/sdk').UpdaterStatus) => void): (() => void) => {
      const fn = (_: unknown, s: import('@omega/sdk').UpdaterStatus): void => cb(s)
      bridge.on(IPC.updaterStatusEvent, fn)
      return () => bridge.removeListener(IPC.updaterStatusEvent, fn)
    }
  },
  engine: {
    command: <T extends EngineCommandType>(
      type: T,
      payload: EngineCommandPayload[T]
    ): Promise<EngineCommandResponse<T>> =>
      bridge.invoke(IPC.engineCommand, {
        id: crypto.randomUUID(),
        type,
        payload
      })
  }
  }
}

export type OmegaApi = ReturnType<typeof createOmegaApi>
