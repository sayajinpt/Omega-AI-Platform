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
  ToolInfo,
  Workflow,
  WorkflowRunEvent,
  WorkflowRunResult,
  BrowserBounds,
  BrowserStatus,
  FinetuneJob,
  FinetuneModelProfile,
  FinetuneModality,
  FinetunePrepareDatasetRequest,
  FinetuneProgress,
  FinetuneStartRequest
} from '@omega/sdk'

export interface OmegaApi {
  config: {
    get: () => Promise<OmegaConfig>
    set: (p: Partial<OmegaConfig>) => Promise<OmegaConfig>
    onChanged: (cb: (cfg: OmegaConfig) => void) => () => void
  }
  modelConfig: {
    get: (modelId: string) => Promise<ModelConfig>
    reset: (modelId: string) => Promise<ModelConfig>
    set: (modelId: string, cfg: Partial<ModelConfig>) => Promise<ModelConfig>
    list: () => Promise<Record<string, ModelConfig>>
  }
  modelPresets: {
    list: () => Promise<Array<{ id: string; label: string; description: string; patch: Partial<ModelConfig> }>>
    apply: (modelId: string, presetId: string) => Promise<ModelConfig>
  }
  runtime: {
    status: () => Promise<{
      state: string
      error?: string
      inference?: string
      activeModel?: string
      nativeLoaded?: string
      routedModel?: string
      runtimeLoadedStems?: string[]
      resolvedCatalogIds?: string[]
    }>
    loadedModels: () => Promise<string[]>
    onStatusChanged: (
      cb: (s: {
        state: string
        activeModel: string
        nativeLoaded: string
        routedModel: string
        runtimeLoadedStems?: string[]
        resolvedCatalogIds?: string[]
      }) => void
    ) => () => void
  }
  system: {
    info: () => Promise<Record<string, unknown>>
  }
  inference: {
    backend: () => Promise<string>
    backends: () => Promise<
      Array<{ backend: 'cuda' | 'vulkan' | 'metal' | 'cpu'; available: boolean; error?: string }>
    >
    switch: (modelId: string) => Promise<void>
  }
  engines: {
    status: () => Promise<{
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
        exl2: { selected: boolean; ready: boolean }
        onnx: { selected: boolean; ready: boolean }
        diskHintMb: number
        pythonPath: string
        installInProgress: boolean
        lastError?: string
      }
    }>
    startOllama: () => Promise<unknown>
    stopOllama: () => Promise<unknown>
    listOllama: () => Promise<Array<{ name: string; size: number }>>
    pullOllama: (name: string) => Promise<{ ok: boolean }>
    onPullProgress: (
      cb: (e: { name: string; status: string; completed?: number; total?: number }) => void
    ) => () => void
    sidecarStatus: () => Promise<{
      scriptPresent: boolean
      venvPresent: boolean
      pythonPath: string
      venvPath: string
      exl2Installed: boolean
      onnxInstalled: boolean
      exl2ImportOk: boolean
      onnxImportOk: boolean
      installInProgress: boolean
      lastError?: string
      diskHintMb: number
    }>
    installSidecar: (components: Array<'exl2' | 'onnx'>) => Promise<{ exl2: boolean; onnx: boolean }>
    uninstallSidecar: () => Promise<unknown>
    onSidecarInstallProgress: (cb: (e: { phase: string; detail: string }) => void) => () => void
  }
  python: {
    status: () => Promise<{
      venv_path: string
      python_path: string
      venv_present: boolean
      setup_running: boolean
      setup_engine?: string
      profile?: Record<string, unknown>
    }>
    setup: (opts?: { profile?: 'base' | 'content' | 'full' }) => Promise<void>
  }
  routerModels: {
    status: () => Promise<{
      scriptPresent: boolean
      setupScriptPresent: boolean
      venvPresent: boolean
      pythonPath: string
      depsOk: boolean
      embeddingReady: boolean
      rerankerReady: boolean
      onnxRuntimeNode: boolean
      nodeOnnxInstallScriptPresent: boolean
      nodeOnnxDiskHintMb: number
      buildInProgress: boolean
      lastError?: string
      deployDir: string
      diskHintMb: number
      diskBuildPeakMb: number
    }>
    installNodeRuntime: () => Promise<unknown>
    setupPython: () => Promise<unknown>
    build: (role: 'embedding' | 'reranker') => Promise<unknown>
    remove: (role: 'embedding' | 'reranker') => Promise<unknown>
    onBuildProgress: (
      cb: (e: { phase: string; detail: string; percent?: number }) => void
    ) => () => void
  }
  gpu: { list: (force?: boolean) => Promise<GpuDevice[]> }
  hf: {
    search: (opts: HFSearchOptions | string) => Promise<HFSearchResult[]>
    card: (repo: string) => Promise<HFModelCard>
    tags: () => Promise<string[]>
  }
  modelMeta: {
    inspect: (modelId: string) => Promise<ModelMetadata>
    estimate: (
      modelId: string,
      cfg: ModelConfig,
      gpuMb?: number,
      gpuBudgetMb?: number
    ) => Promise<MemoryEstimate>
    estimateFile: (
      sizeBytes: number,
      contextSize?: number,
      quant?: string
    ) => Promise<{ weightsMb: number; kvCacheMb: number; vramMb: number; ramMbIfCpu: number }>
  }
  models: {
    list: () => Promise<ModelInfo[]>
    onInventoryChanged: (cb: () => void) => () => void
    unload: (m: string) => Promise<void>
    load: (m: string) => Promise<{ activeModel: string; loaded: boolean; nativeLoaded: string | null }>
    delete: (m: string) => Promise<void>
    repoFiles: (repo: string) => Promise<string[]>
    checkHfAccess: (repo: string) => Promise<{
      ok: boolean
      status: number
      hasToken: boolean
      pageUrl: string
      gated: boolean
      hint: 'accept_license' | 'add_token' | 'refresh_token' | null
    }>
    openHfRepo: (repo: string) => Promise<{ opened: boolean; pageUrl: string }>
    download: (repo: string, file: string) => Promise<{ path: string }>
    downloadRequired: (req: {
      repo: string
      files: HFFile[]
      primaryPath?: string
      visionPath?: string
      tags?: string[]
    }) => Promise<{ paths: string[]; downloaded: string[] }>
    cancelDownload: (repo: string, file: string) => Promise<boolean>
    downloadAdapter: (repo: string, file: string) => Promise<{ path: string }>
    onDownloadProgress: (cb: (p: unknown) => void) => () => void
    onLoadProgress: (cb: (p: { modelId: string; phase: string; detail?: string; percent?: number }) => void) => () => void
    quantize: (req: QuantizeRequest) => Promise<{ path: string }>
    onQuantizeProgress: (cb: (p: unknown) => void) => () => void
    benchmark: (m: string) => Promise<Record<string, unknown>>
    footprint: (m: string) => Promise<Record<string, unknown>>
  }
  sessions: {
    list: () => Promise<Array<{ id: string; title: string; modelId: string; updatedAt: number }>>
    search: (query: string) => Promise<
      Array<{ id: string; title: string; modelId: string; updatedAt: number; systemPrompt?: string }>
    >
    messages: (id: string) => Promise<Array<{ role: string; content: string }>>
    create: (title: string, modelId: string, sp: string) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    updateTitle: (id: string, title: string) => Promise<void>
    updateModel: (id: string, modelId: string) => Promise<{ ok: boolean; modelId?: string }>
    fork: (id: string) => Promise<{ id: string; title: string }>
    truncate: (id: string, fromIndex: number) => Promise<void>
    contextBuffer: (sessionId: string, modelId: string) => Promise<ContextBufferState>
  }
  memory: {
    list: () => Promise<MemoryEntry[]>
    add: (kind: string, content: string, sessionId?: string) => Promise<MemoryEntry>
    delete: (id: string) => Promise<void>
    search: (q: string) => Promise<MemoryEntry[]>
    graph: (runId?: string) => Promise<DecisionNode[]>
    projectContext: (sessionId?: string) => Promise<import('@omega/sdk').ProjectMemoryContext>
    exportBundle: () => Promise<import('@omega/sdk').MemoryBundle>
    importBundle: (
      bundle: import('@omega/sdk').MemoryBundle,
      mode?: 'merge' | 'replace'
    ) => Promise<{ imported: number; skipped: number }>
    runJanitor: () => Promise<{ memoryRemoved: number; note: string }>
  }
  project: {
    openFolder: (sessionId: string) => Promise<{ ok: boolean; path: string; error?: string }>
    listFiles: (sessionId: string) => Promise<Array<{ sub: string; name: string; path: string }>>
  }
  tools: {
    list: () => Promise<ToolInfo[]>
    toggle: (n: string, e: boolean) => Promise<void>
    run: (n: string, a: Record<string, string>) => Promise<{ ok: boolean; output: string }>
    onApproveRequest: (cb: (req: ToolApprovalRequest) => void) => () => void
    approve: (id: string, approved: boolean) => Promise<void>
  }
  permissions: {
    onRequest: (cb: (req: import('@omega/sdk').CapabilityPermissionRequest) => void) => () => void
    resolve: (id: string, approved: boolean, remember?: boolean) => Promise<void>
  }
  plugins: {
    list: () => Promise<PluginInfo[]>
    toggle: (id: string, e: boolean) => Promise<void>
    reload: () => Promise<PluginInfo[]>
  }
  workflows: {
    list: () => Promise<Workflow[]>
    get: (id: string) => Promise<Workflow | undefined>
    save: (wf: Omit<Workflow, 'updatedAt'>) => Promise<Workflow>
    delete: (id: string) => Promise<void>
    run: (id: string, vars: Record<string, string>, model: string) => Promise<WorkflowRunResult>
    abort: (runId?: string) => Promise<void>
    onEvent: (cb: (e: WorkflowRunEvent) => void) => () => void
  }
  inputPipelines: {
    list: () => Promise<import('@omega/sdk').InputPipeline[]>
    get: (id: string) => Promise<import('@omega/sdk').InputPipeline | undefined>
    save: (row: Omit<import('@omega/sdk').InputPipeline, 'updatedAt'>) => Promise<import('@omega/sdk').InputPipeline>
    delete: (id: string) => Promise<void>
    setActive: (scope: import('@omega/sdk').InputPipelineScope, id: string) => Promise<import('@omega/sdk').InputPipeline | undefined>
  }
  skills: {
    list: () => Promise<Skill[]>
    get: (id: string) => Promise<SkillContent | null>
    save: (input: {
      id?: string
      name: string
      description: string
      category?: string
      tags?: string[]
      enabled?: boolean
      body: string
    }) => Promise<SkillContent>
    delete: (id: string) => Promise<void>
    toggle: (id: string, enabled: boolean) => Promise<SkillContent | null>
  }
  profiles: {
    list: () => Promise<Profile[]>
    create: (id: string, cloneFrom?: string) => Promise<Profile>
    switch: (id: string) => Promise<Profile>
    delete: (id: string) => Promise<void>
  }
  soul: {
    get: () => Promise<Soul>
    set: (s: Soul) => Promise<Soul>
    reset: () => Promise<Soul>
  }
  orchestratorPrompts: {
    getDefaults: () => Promise<import('@omega/sdk').OrchestratorPromptDefaults>
  }
  cron: {
    list: () => Promise<CronJob[]>
    save: (job: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt'> & { id?: string }) => Promise<CronJob>
    delete: (id: string) => Promise<void>
    pause: (id: string, paused: boolean) => Promise<CronJob | undefined>
    runNow: (id: string) => Promise<CronJob | undefined>
    onChange: (cb: (jobs: CronJob[]) => void) => () => void
  }
  kanban: {
    list: () => Promise<KanbanTask[]>
    save: (task: Partial<KanbanTask> & { title: string }) => Promise<KanbanTask>
    move: (id: string, status: KanbanStatus) => Promise<KanbanTask | undefined>
    delete: (id: string) => Promise<void>
    dispatch: (id?: string) => Promise<KanbanTask | null>
    onChange: (cb: (tasks: KanbanTask[]) => void) => () => void
  }
  mcp: {
    list: () => Promise<McpServerConfig[]>
    save: (s: McpServerConfig) => Promise<McpServerConfig>
    delete: (id: string) => Promise<void>
    start: (id: string) => Promise<McpServerStatus | null>
    stop: (id: string) => Promise<void>
    status: () => Promise<McpServerStatus[]>
    onStatus: (cb: (s: McpServerStatus[]) => void) => () => void
  }
  providers: {
    list: () => Promise<RemoteProvider[]>
    save: (p: RemoteProvider) => Promise<RemoteProvider>
    delete: (id: string) => Promise<void>
    presets: () => Promise<RemoteProvider[]>
    discover: () => Promise<Array<{ providerId: string; modelId: string; displayName: string }>>
    fetchModels: (providerId: string, persist?: boolean) => Promise<{ models: string[]; error?: string }>
    onChanged: (cb: () => void) => () => void
  }
  gateway: {
    platforms: () => Promise<Array<{
      id: GatewayPlatformId
      label: string
      group: string
      implemented: boolean
      fields: Array<{ name: string; label: string; type?: 'text' | 'password' | 'url' }>
    }>>
    list: () => Promise<GatewayPlatformConfig[]>
    save: (c: GatewayPlatformConfig) => Promise<GatewayPlatformConfig>
    delete: (id: GatewayPlatformId) => Promise<void>
    start: (id: GatewayPlatformId) => Promise<GatewayStatus | null>
    stop: (id: GatewayPlatformId) => Promise<void>
    status: () => Promise<GatewayStatus[]>
    onStatus: (cb: (s: GatewayStatus[]) => void) => () => void
  }
  pluginStore: {
    catalog: () => Promise<PluginCatalogEntry[]>
    installBuiltin: (id: string) => Promise<PluginManifest>
    installUrl: (url: string) => Promise<PluginManifest>
    uninstall: (id: string) => Promise<void>
  }
  rag: {
    list: () => Promise<RagSource[]>
    indexFile: (path: string) => Promise<number>
    indexDir: (path: string) => Promise<{ files: number; chunks: number }>
    clear: (source?: string) => Promise<void>
    search: (query: string) => Promise<RagHit[]>
  }
  chat: {
    send: (req: ChatRequest & { streamId: string; sessionId?: string; agentMode?: boolean }) => Promise<GenerateResult>
    abort: (id: string) => Promise<void>
    pickAttachments: () => Promise<string[]>
    stageAttachment: (sessionId: string, sourcePath: string) => Promise<import('@omega/sdk').MediaRef>
    stageAttachmentData: (
      sessionId: string,
      name: string,
      dataBase64: string,
      mime?: string
    ) => Promise<import('@omega/sdk').MediaRef>
    attachmentLimits: () => Promise<{ maxBytes: number; maxCount: number }>
    onToken: (cb: (p: { streamId: string; token: Token }) => void) => () => void
    onMetrics: (
      cb: (p: { streamId: string; metrics: import('@omega/sdk').InferenceMetricsSnapshot }) => void
    ) => () => void
    onDone: (cb: (p: { streamId: string; result: GenerateResult }) => void) => () => void
    onError: (cb: (p: { streamId: string; error: string }) => void) => () => void
    onMedia: (cb: (p: { streamId: string; part: import('@omega/sdk').MessagePart }) => void) => () => void
    onSessionMessage: (
      cb: (p: { sessionId: string; message: import('@omega/sdk').Message }) => void
    ) => () => void
    onSessionAssistantPatch: (
      cb: (p: {
        sessionId: string
        content?: string
        parts: import('@omega/sdk').MessagePart[]
        jobId?: string
        messageIndex?: number
      }) => void
    ) => () => void
  }
  pipeline: {
    get: () => Promise<import('../../../shared/pipeline-activity').PipelineActivity>
    onChanged: (cb: (a: import('../../../shared/pipeline-activity').PipelineActivity) => void) => () => void
  }
  agent: {
    run: (req: AgentRunRequest) => Promise<AgentRunResult>
    abort: () => Promise<void>
    onStep: (cb: (s: AgentStep) => void) => () => void
    onToken: (cb: (t: Token) => void) => () => void
  }
  debug: {
    history: () => Promise<DebugEvent[]>
    onEvent: (cb: (e: DebugEvent) => void) => () => void
  }
  contentStudio: {
    status: () => Promise<import('@omega/sdk').ContentStudioStatus>
    setupEnvironment: (opts?: { profile?: 'content' | 'content-media' }) => Promise<void>
    onSetupProgress: (
      cb: (p: import('@omega/sdk').ContentStudioSetupProgress) => void
    ) => () => void
    onChanged: (cb: () => void) => () => void
    start: () => Promise<void>
    stop: () => Promise<void>
    restart: () => Promise<void>
    listProjects: () => Promise<import('@omega/sdk').ContentStudioProject[]>
    createRun: (body: {
      title?: string
      theme?: string
      project_id?: string
      pipeline_mode?: string
      episode_topic?: string
    }) => Promise<import('@omega/sdk').ContentStudioRun>
    runStatus: (jobId: string) => Promise<import('@omega/sdk').ContentStudioRunStatus>
    forceStopJob: (body: {
      sessionId?: string
      jobId: string
      projectId?: string
      title?: string | null
    }) => Promise<{ ok: boolean; message: string; phase?: 'stopping' | 'cancelled' }>
    listSchedules: () => Promise<import('@omega/sdk').ContentSchedule[]>
    createSchedule: (body: {
      project_id?: string
      series_id?: string
      cron_expression: string
      timezone?: string
    }) => Promise<import('@omega/sdk').ContentSchedule>
    scheduleDelete: (id: string) => Promise<void>
    socialPlatforms: () => Promise<import('@omega/sdk').ContentSocialPlatform[]>
    socialAccounts: () => Promise<import('@omega/sdk').ContentSocialAccount[]>
    socialPosts: () => Promise<import('@omega/sdk').ContentSocialPost[]>
    socialPublish: (body: {
      platform: string
      title: string
      caption?: string
      project_id?: string
      publish_now?: boolean
    }) => Promise<import('@omega/sdk').ContentSocialPost>
    credentials: {
      get: () => Promise<import('@omega/sdk').ContentStudioCredentials>
      set: (creds: import('@omega/sdk').ContentStudioCredentials) => Promise<import('@omega/sdk').ContentStudioCredentials>
      sync: () => Promise<{ platforms: Record<string, boolean> }>
      status: () => Promise<Record<string, boolean>>
    }
    youtube: {
      connect: () => Promise<{ refreshToken: string }>
    }
    listSeries: () => Promise<import('@omega/sdk').ContentSeries[]>
    createSeries: (body: {
      title: string
      theme: string
      default_max_duration_seconds?: number
    }) => Promise<import('@omega/sdk').ContentSeries>
    deleteSeries: (id: string) => Promise<void>
    generation: {
      get: () => Promise<import('@omega/sdk').ContentStudioGenerationSettings>
      set: (
        settings: import('@omega/sdk').ContentStudioGenerationSettings
      ) => Promise<import('@omega/sdk').ContentStudioGenerationSettings>
      catalog: () => Promise<import('@omega/sdk').ContentGenerationCatalog>
      capabilities: (
        modality: 'tts' | 'image' | 'video',
        repoId: string
      ) => Promise<import('@omega/sdk').GenerationCapabilities>
      downloadModel: (
        kind: 'tts' | 'image' | 'image_adapter',
        repoId: string,
        label?: string,
        sizeHint?: string
      ) => Promise<{ dest: string; repoId: string; kind: 'tts' | 'image' | 'image_adapter' }>
    }
  }
  finetune: {
    analyze: (modelId: string) => Promise<FinetuneModelProfile>
    prepareDataset: (req: FinetunePrepareDatasetRequest) => Promise<{
      trainPath: string
      sampleCount: number
      preview: string
    }>
    list: () => Promise<FinetuneJob[]>
    get: (id: string) => Promise<FinetuneJob | undefined>
    create: (req: FinetuneStartRequest) => Promise<FinetuneJob>
    start: (jobId: string) => Promise<FinetuneJob>
    abort: (jobId: string) => Promise<void>
    delete: (jobId: string) => Promise<void>
    onProgress: (cb: (p: FinetuneProgress) => void) => () => void
    listDatasets: () => Promise<import('@omega/sdk').FinetuneDatasetEntry[]>
    listPresets: () => Promise<import('@omega/sdk').FinetuneDatasetPreset[]>
    savePreset: (input: {
      name: string
      sources: string[]
      modality: import('@omega/sdk').FinetuneModality
      format?: import('@omega/sdk').FinetuneDatasetSpec['format']
    }) => Promise<import('@omega/sdk').FinetuneDatasetPreset>
    deletePreset: (id: string) => Promise<void>
    inspectSource: (path: string) => Promise<import('@omega/sdk').FinetuneSourceInspect>
    pickSources: () => Promise<string[]>
    datasetsRoot: () => Promise<string>
    deletePrepared: (id: string) => Promise<boolean>
  }
  editor: {
    read: (filePath: string) => Promise<string>
    write: (filePath: string, content: string) => Promise<void>
    openFiles: () => Promise<Array<{ path: string; content: string; language: string; title: string }>>
    saveAs: (content: string, suggestedPath?: string) => Promise<string | null>
    deleteFile: (filePath: string) => Promise<void>
  }
  terminal: {
    history: () => Promise<import('@omega/sdk').TerminalLine[]>
    clear: () => Promise<void>
    runSnippet: (opts: {
      lang: string
      code: string
      path?: string
      suggestedName?: string
      source?: 'terminal' | 'snippet'
      sessionId?: string
    }) => Promise<{ ok: boolean; error?: string; output?: string; script?: string }>
    runCommand: (
      command: string,
      opts?: { sessionId?: string }
    ) => Promise<{ ok: boolean; error?: string; output?: string }>
    saveSnippet: (content: string, suggestedName: string) => Promise<string | null>
    onLine: (cb: (line: import('@omega/sdk').TerminalLine) => void) => () => void
  }
  browser: {
    show: (bounds: BrowserBounds, mode?: 'mini' | 'full') => Promise<void>
    hide: () => Promise<void>
    mediaCommand: (cmd: {
      action: 'stop' | 'pause' | 'resume' | 'play'
    }) => Promise<{ ok?: boolean }>
    setBounds: (bounds: BrowserBounds) => Promise<void>
    navigate: (url: string) => Promise<BrowserStatus>
    back: () => Promise<BrowserStatus | null>
    forward: () => Promise<BrowserStatus | null>
    reload: () => Promise<BrowserStatus | null>
    getStatus: () => Promise<BrowserStatus | null>
    info: () => Promise<{ available: boolean; error?: string }>
    onStatus: (cb: (s: BrowserStatus) => void) => () => void
    onHidden: (cb: () => void) => () => void
  }
  shortcuts: {
    on: (cb: (e: { action: string; page?: string }) => void) => () => void
  }
  usage: {
    summary: (sessionId?: string) => Promise<import('@omega/sdk').UsageSummary>
  }
  workforce: {
    agents: () => Promise<import('@omega/sdk').WorkforceAgent[]>
    runs: () => Promise<import('@omega/sdk').WorkforceRun[]>
    delegate: (agentId: string, task: string) => Promise<string>
    runMoA: (task: string) => Promise<string>
    runParallel: (tasks: Array<{ agentId: string; task: string }>) => Promise<string[]>
    setStandup: (active: boolean) => Promise<import('@omega/sdk').OfficeSnapshot>
  }
  office: {
    snapshot: () => Promise<import('@omega/sdk').OfficeSnapshot>
    addMonitor: (body: {
      title: string
      kind: 'pr' | 'task' | 'log' | 'standup' | 'jira'
      summary: string
      url?: string
    }) => Promise<import('@omega/sdk').OfficeMonitor>
    refreshMonitor: (monitorId: string) => Promise<import('@omega/sdk').OfficeMonitor | null>
    fetchPr: (url: string) => Promise<import('@omega/sdk').PrMonitorData>
    prComment: (owner: string, repo: string, number: number, body: string) => Promise<void>
    prReview: (
      owner: string,
      repo: string,
      number: number,
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      body?: string
    ) => Promise<void>
    jiraComment: (issueKey: string, text: string) => Promise<void>
    pollSet: (enabled: boolean, intervalMs?: number) => Promise<import('@omega/sdk').OfficeSnapshot>
    pollRefreshAll: () => Promise<number>
    skillGym: () => Promise<string>
    officeJanitor: () => Promise<{ sessions: number; removed: number; note: string }>
    kanbanPin: (taskId: string, pinned: boolean) => Promise<import('@omega/sdk').OfficeSnapshot>
    kanbanMonitor: (taskId: string) => Promise<import('@omega/sdk').OfficeMonitor | null>
    onChanged: (cb: (snap: import('@omega/sdk').OfficeSnapshot) => void) => () => void
    visualizationStatus: () => Promise<import('@omega/sdk').OfficeVisualizationStatus>
    visualizationSetup: () => Promise<{ ok: boolean; error?: string; log?: string }>
    startVisualization: () => Promise<{
      success: boolean
      error?: string
      officeReady?: boolean
      gatewayReady?: boolean
    }>
    stopVisualization: () => Promise<void>
  }
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
    ) => () => void
    pause: () => Promise<{ ok: boolean; output: string }>
    resume: () => Promise<{ ok: boolean; output: string }>
    stop: () => Promise<void>
    showPreview: (sessionId: string, part: import('@omega/sdk').MessagePart) => Promise<{ ok: boolean }>
    reopenSessionVideo: (
      sessionId: string,
      jobId?: string
    ) => Promise<{ ok: boolean; message: string }>
  }
  voice: {
    onSpeak: (cb: (p: { text: string; mode: string }) => void) => () => void
  }
  assistant: {
    defaultPrompt: () => Promise<string>
  }
  integrations: {
    get: () => Promise<import('@omega/sdk').IntegrationsConfig>
    set: (cfg: import('@omega/sdk').IntegrationsConfig) => Promise<import('@omega/sdk').IntegrationsConfig>
  }
  selfImprove: {
    list: () => Promise<import('@omega/sdk').SelfImproveEntry[]>
    reflect: (sessionId: string) => Promise<import('@omega/sdk').SelfImproveEntry | null>
    janitor: (sessionId: string) => Promise<{ removed: number; note: string }>
  }
  updater: {
    status: () => Promise<import('@omega/sdk').UpdaterStatus>
    check: () => Promise<import('@omega/sdk').UpdaterStatus>
    install: () => Promise<void>
    onStatus: (cb: (s: import('@omega/sdk').UpdaterStatus) => void) => () => void
  }
  screenSnip: {
    capture: () => Promise<import('../../../shared/screen-snip-types').ScreenSnipCaptureResult | null>
    getBounds: () => Promise<import('../../../shared/screen-snip-types').VirtualDesktopBounds | null>
    submit: (rect: import('../../../shared/screen-snip-types').ScreenSnipRect) => Promise<
      import('../../../shared/screen-snip-types').ScreenSnipCaptureResult
    >
    cancel: () => Promise<null>
    save: (tempPath: string) => Promise<boolean>
    onInit: (cb: (bounds: import('../../../shared/screen-snip-types').VirtualDesktopBounds) => void) => () => void
  }
  companion: {
    setActiveChat: (state: {
      sessionId: string | null
      modelId: string
      systemPrompt: string
    }) => void
    getActiveChat: () => Promise<{
      sessionId: string | null
      modelId: string
      systemPrompt: string
    }>
    sendToMainChat: (detail: {
      text: string
      attachments?: import('@omega/sdk').MediaRef[]
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    onSendDeliver: (
      cb: (detail: { text: string; attachments?: import('@omega/sdk').MediaRef[] }) => void
    ) => () => void
    broadcastReply: (payload: {
      userText?: string
      assistantText: string
      done: boolean
      error?: string
    }) => void
    onReplyDeliver: (cb: (payload: {
      userText?: string
      assistantText: string
      done: boolean
      error?: string
    }) => void) => () => void
  }
  avatarMonitor: {
    setEnabled: (
      enabled: boolean,
      state?: { x?: number; y?: number; collapsed?: boolean; scale?: number }
    ) => Promise<{ enabled: boolean }>
    getEnabled: () => Promise<{ enabled: boolean }>
    pushSignals: (signals: {
      speaking: number
      listening: number
      state: 'idle' | 'thinking' | 'speaking' | 'error'
    }) => void
    syncLayout: (layout: {
      collapsed: boolean
      scale?: number
      x?: number
      y?: number
      animationStyle?: 'neural_mesh' | 'matrix_layers' | 'spider_web'
    }) => void
    restoreMain: () => Promise<boolean>
    onSignals: (cb: (s: {
      speaking: number
      listening: number
      state: 'idle' | 'thinking' | 'speaking' | 'error'
    }) => void) => () => void
    onEnabled: (cb: (enabled: boolean) => void) => () => void
    onLayout: (
      cb: (layout: {
        x: number
        y: number
        collapsed: boolean
        scale?: number
        animationStyle?: 'neural_mesh' | 'matrix_layers' | 'spider_web'
      }) => void
    ) => () => void
  }
  onContextFind: (cb: () => void) => () => void
  onContextGotoLine: (cb: () => void) => () => void
  engine: {
    command: <T extends import('@omega/sdk').EngineCommandType>(
      type: T,
      payload: import('@omega/sdk').EngineCommandPayload[T]
    ) => Promise<import('@omega/sdk').EngineCommandResponse<T>>
  }
}

declare global {
  interface Window {
    omega: OmegaApi
  }
}

export {}
