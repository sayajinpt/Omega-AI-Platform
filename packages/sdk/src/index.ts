/** Shared types for the Omega desktop app and runtime protocol. */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** Rich message part (attachments & model media). See docs/CHAT-AND-MEDIA.md. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: string; alt?: string; width?: number; height?: number }
  | { type: 'audio'; ref: string; durationMs?: number }
  | { type: 'video'; ref: string; posterRef?: string; durationMs?: number }
  | { type: 'file'; ref: string; name: string; mime?: string; sizeBytes?: number }
  /** Content Studio job card — open studio, poll, play when videoRef is set. */
  | {
      type: 'content_studio'
      jobId: string
      projectId: string
      status: string
      title?: string
      videoRef?: string
      youtubeUrl?: string | null
      startedAt?: number
      completedAt?: number
      elapsedMs?: number
    }
  /** Direct text-to-video job card (diffusers pack, session media folder). */
  | {
      type: 'direct_video'
      jobId: string
      status: string
      title?: string
      videoRef?: string
      error?: string
      /** Epoch ms when the job card was created. */
      startedAt?: number
      /** Epoch ms when the job reached a terminal state. */
      completedAt?: number
      /** Wall-clock duration in ms (set when job finishes). */
      elapsedMs?: number
    }
  /** Clickable suggestions when the assistant needs parameters or clarification. */
  | {
      type: 'choices'
      prompt?: string
      allowCustom?: boolean
      multiSelect?: boolean
      /** When "textarea", show a multi-line script input instead of chip options only. */
      inputKind?: 'text' | 'textarea'
      options: Array<{
        id: string
        label: string
        description?: string
        value: string
      }>
      status?: 'pending' | 'answered' | 'dismissed'
      /** Set when user picks or sends a custom reply. */
      selectedValue?: string
    }
  /** YouTube embed from play_youtube tool — shown inline in the assistant bubble. */
  | {
      type: 'youtube'
      embedUrl?: string
      watchUrl?: string
      title?: string
    }

/** Staged or generated media on disk under ~/.omega/sessions/… */
export interface MediaRef {
  id: string
  kind: 'image' | 'audio' | 'video' | 'file'
  path: string
  mime: string
  sha256?: string
  thumbPath?: string
  name?: string
  sizeBytes?: number
}

export interface Message {
  role: Role
  /** Plain text; always set for backward compatibility. */
  content: string
  /** Chain-of-thought / thinking extracted from assistant output (shown separately in chat UI). */
  reasoningContent?: string
  /** True while the model is still emitting thought tokens (streaming). */
  reasoningOpen?: boolean
  /** Multimodal parts (optional; see docs/CHAT-AND-MEDIA.md). */
  parts?: MessagePart[]
  attachments?: MediaRef[]
  /** Absolute image paths for runtime mtmd vision (main → omega-runtime). */
  imagePaths?: string[]
  name?: string
}

export interface SamplingParams {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  stop?: string[]
}

export interface GenerateRequest {
  model: string
  prompt: string
  sampling?: SamplingParams
}

export interface ChatRequest {
  model: string
  messages: Message[]
  sampling?: SamplingParams
  /** Override per-model thinking setting for this request. */
  enableThinking?: boolean
  /** When true, chat uses tools + memory (agent mode). */
  agentMode?: boolean
  /** Staged files for the outgoing user turn (main process persists parts). */
  attachments?: MediaRef[]
}

export interface EmbedRequest {
  model: string
  input: string[]
}

export interface Token {
  text: string
  index: number
  is_final?: boolean
  logprob?: number
}

/** Live inference telemetry for companion compute-trace HUD. */
export type InferenceMetricsSource = 'engine' | 'runtime' | 'ollama' | 'remote' | 'estimated'

export interface TokenProbabilityCandidate {
  text: string
  probability: number
}

export interface InferenceMetricsSnapshot {
  phase: 'idle' | 'prefill' | 'decode' | 'loading'
  backend: InferenceMetricsSource
  /** KV cache fill (sequence position). */
  kvTokens: number
  /** Estimated or measured prompt tokens for this request. */
  promptTokens?: number
  /** Estimated or measured completion tokens for this request. */
  completionTokens?: number
  contextSize: number
  /** Last decoded piece. */
  selectedToken?: string
  /** Probability of selected token (native peek when available). */
  confidence?: number
  /** Shannon entropy of top distribution (nats, normalized 0–1 for HUD). */
  entropy?: number
  topK: TokenProbabilityCandidate[]
  /**
   * Context-token affinity matrix (recent tokens), not transformer attention weights.
   * values[row][col] in 0–1.
   */
  contextAffinity: number[][]
  contextAffinityLabels: string[]
  activeLayer?: number
  totalLayers?: number
  gpuLayers?: number
  /** @deprecated Prefer generationTokenRate — kept for older callers. */
  tokenRate?: number
  /** Input / prefill throughput (prompt processing). */
  promptTokenRate?: number
  /** Output / decode throughput (token generation). */
  generationTokenRate?: number
  /** True when rates come from engine/provider timings, not char estimates. */
  measured?: boolean
  measuredAt: number
}

/** Streaming chat event (text + generated media). */
export type ChatStreamEvent =
  | { type: 'token'; token: Token }
  | { type: 'media'; part: MessagePart; messageRole?: 'assistant' }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason?: string }

export interface GenerateResult {
  text: string
  tokens_in: number
  tokens_out: number
  prompt_ms?: number
  gen_ms?: number
  stop_reason: string
  /** Rich assistant parts (code blocks, choices, etc.) from agent tool results. */
  parts?: MessagePart[]
  /** Estimated USD when using a remote provider (heuristic pricing table). */
  cost_usd?: number
  /** Provider id when remote (e.g. openai, openrouter). */
  usage_provider?: string
}

/** Per-request API usage row (remote providers). */
export interface UsageRecord {
  id: string
  sessionId?: string
  model: string
  providerId?: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  createdAt: number
}

export interface UsageSummary {
  sessionId?: string
  totalTokensIn: number
  totalTokensOut: number
  totalCostUsd: number
  records: UsageRecord[]
}

export type WorkforceAgentRole = 'planner' | 'executor' | 'critic' | 'researcher' | 'reviewer' | 'general'

export interface WorkforceAgent {
  id: string
  name: string
  role: WorkforceAgentRole
  modelId: string
  color: string
}

export type WorkforceRunStatus = 'queued' | 'running' | 'done' | 'error' | 'aborted'

export interface WorkforceRun {
  id: string
  mode: 'single' | 'delegate' | 'moa' | 'parallel'
  task: string
  status: WorkforceRunStatus
  agentIds: string[]
  parentRunId?: string
  output?: string
  error?: string
  createdAt: number
  updatedAt: number
}

export type OfficeWorkerStatus = 'idle' | 'working' | 'meeting' | 'review' | 'standup' | 'gym' | 'error'
export type OfficeZone = 'desk' | 'conference' | 'monitor' | 'gym' | 'janitor'

export interface OfficeWorker {
  agentId: string
  name: string
  role: WorkforceAgentRole
  status: OfficeWorkerStatus
  zone: OfficeZone
  task?: string
  runId?: string
  /** Live agent-step label (planner/executor/critic). */
  activityTitle?: string
  activityKind?: AgentStep['kind']
  /** 0–1 layout coordinates in the office canvas */
  x: number
  y: number
  /** Animation target when agent is active */
  targetX?: number
  targetY?: number
}

export interface PrDiffFile {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  patch?: string
}

export interface PrMonitorData {
  owner: string
  repo: string
  number: number
  title: string
  state: string
  author: string
  body?: string
  files: PrDiffFile[]
  fetchedAt: number
}

export interface JiraIssueData {
  key: string
  summary: string
  status: string
  assignee?: string
  reporter?: string
  priority?: string
  issueType?: string
  description?: string
  url: string
  comments: Array<{ author: string; body: string; created: string }>
  fetchedAt: number
}

export interface IntegrationsConfig {
  github?: { token?: string }
  jira?: { baseUrl?: string; email?: string; apiToken?: string }
}

export interface OfficeMonitor {
  id: string
  title: string
  kind: 'pr' | 'task' | 'log' | 'standup' | 'jira'
  summary: string
  url?: string
  pr?: PrMonitorData
  jira?: JiraIssueData
}

export interface OfficeKanbanPin {
  taskId: string
  title: string
  status: KanbanStatus
  priority: KanbanTask['priority']
}

export interface OfficePollState {
  enabled: boolean
  intervalMs: number
  lastPollAt?: number
}

export interface OfficeSnapshot {
  workers: OfficeWorker[]
  monitors: OfficeMonitor[]
  standupActive: boolean
  skillGymActive: boolean
  janitorActive: boolean
  poll: OfficePollState
  kanbanPins: OfficeKanbanPin[]
  updatedAt: number
}

export interface SelfImproveEntry {
  id: string
  sessionId?: string
  insight: string
  action?: string
  applied: boolean
  createdAt: number
}

export interface UpdaterStatus {
  checking: boolean
  available: boolean
  downloading?: boolean
  downloadPercent?: number
  /** True when running from a packaged install (not dev checkout). */
  packaged?: boolean
  /** Installer already downloaded to temp cache. */
  downloadReady?: boolean
  /** Resolved manifest URL, env override, or local ~/.omega path. */
  manifestSource?: string
  currentVersion?: string
  version?: string
  notes?: string
  message?: string
  error?: string
}

/** GPU attention backend (Settings → Performance and per-model override). */
export type GpuAttentionMode = 'auto' | 'flash' | 'off'

/**
 * GPU attention modes (Settings → Performance).
 * ``auto`` lets PyTorch SDPA / llama.cpp pick kernels (recommended for diffusion).
 * ``flash`` forces the flash-attn wheel when installed.
 */
export interface GpuAttentionSettings {
  /** Chat GGUF (omega-engine). Default ``auto``. */
  chatMode?: GpuAttentionMode
  /** Content Studio TTS + diffusers. Default ``auto``. */
  contentStudioMode?: GpuAttentionMode
  /** @deprecated Use ``chatMode`` (`off` / `flash`). */
  chatEnabled?: boolean
  /** @deprecated Use ``contentStudioMode`` (`off` / `flash`). */
  contentStudioEnabled?: boolean
}

/** Default models & voice for Omega assistant / Content Studio (Settings → Omega tools). */
export interface OmegaToolsSettings {
  /** When false, chat uses text only (current behavior). */
  voiceEnabled?: boolean
  /** When true, assistant text replies are read aloud after each chat response. */
  voiceOutputEnabled?: boolean
  /** Chat / desktop assistant model (falls back to defaultModel). */
  assistantModelId?: string
  /** HuggingFace repo id for Content Studio TTS. */
  contentStudioTtsRepoId?: string
  /** HuggingFace repo id for Content Studio txt-to-img. */
  contentStudioImageRepoId?: string
  /** HuggingFace repo id for direct text-to-video (diffusers pack under video/). */
  contentStudioVideoRepoId?: string
  /** Per-repo inference steps (0 = use catalog default). Key = HF repo id. */
  contentStudioImageStepsByRepo?: Record<string, number>
  /** Per-repo T2V inference steps (0 = catalog default). Key = HF repo id. */
  contentStudioVideoStepsByRepo?: Record<string, number>
  /**
   * Per-repo output size. ``width``/``height`` of 0 = catalog default;
   * both ``-1`` = use video brief aspect (16:9 / 9:16).
   */
  contentStudioImageSizeByRepo?: Record<string, ImageSizeOverride>
  /** Per-repo T2V output size (0/0 = catalog default). Key = HF repo id. */
  contentStudioVideoSizeByRepo?: Record<string, ImageSizeOverride>
  /** LoRA adapters for Content Studio image models. */
  contentStudioImageAdapters?: ImageModelAdapterEntry[]
  /**
   * SDXL / diffusion VRAM strategy for Content Studio renders.
   * - `all_gpu` — full pipeline on GPU (default; matches standalone qwen_tts_gui).
   * - `auto` — keep all on GPU unless free VRAM is low before a scene, then offload text encoders.
   * - `offload_encoders` — pre-encode prompts and move CLIP stacks to CPU (saves VRAM; may be slower / fragile).
   */
  contentStudioImageVramMode?: 'all_gpu' | 'auto' | 'offload_encoders'
  /** TTS for Omega voice replies (repo id or `browser` for OS speech). */
  voiceTtsModelId?: string
  /** STT for voice input (`browser` = Web Speech API, or whisper model id/path). */
  voiceSttModelId?: string
  /** Folder scanned for play_local_media (default: Music under home). */
  mediaLibraryPath?: string
}

/** 3D office visualization server (start/stop does not affect agent work). */
export interface OfficeVisualizationStatus {
  bundled: boolean
  installed: boolean
  devServerRunning: boolean
  adapterRunning: boolean
  running: boolean
  /** HTTP server accepting connections on office port */
  officeReady?: boolean
  port: number
  wsUrl: string
  officeUrl: string
  /** Gateway adapter HTTP health (127.0.0.1:18789). */
  gatewayReady?: boolean
  /** Shell embeds office via native WebView2 (not iframe) — required on packaged Windows build. */
  nativeEmbed?: boolean
  error?: string
}

/** @deprecated Use OfficeVisualizationStatus */
export type Claw3dStatus = OfficeVisualizationStatus

/** On-disk / Hub weight container format. */
export type WeightFormat =
  | 'gguf'
  | 'safetensors'
  | 'pytorch'
  | 'awq'
  | 'gptq'
  | 'exl2'
  | 'mlx'
  | 'onnx'
  | 'config'
  | 'other'

export type ModelModality = 'text' | 'vision' | 'audio'

export interface ModelInfo {
  id: string
  path: string
  size_bytes: number
  /** Capabilities inferred from name/architecture (vision VLMs, etc.). */
  modalities?: ModelModality[]
  /** Weight format on disk (gguf, safetensors, onnx, …). */
  format?: WeightFormat
  /** In-process GGUF via omega-engine / omega-runtime. */
  nativeSupported?: boolean
  /** Recommended inference path for this entry. */
  inferenceBackend?: 'engine' | 'ollama' | 'runtime' | 'remote' | 'exl2' | 'onnx'
  /** Cloud / OpenAI-compatible provider entry (not on disk). */
  remote?: boolean
  displayName?: string
  metadata: {
    architecture?: string
    quantization?: string
    context_len?: number
    param_count?: number
    /** Human label: folder name, quant tag, or provider name. */
    formatLabel?: string
    /** Filename/tag suggests Multi-Token Prediction (MTP) weights or variant. */
    supportsMtp?: boolean
    /** Full HuggingFace repo id when known (e.g. cutycat2000/InterDiffusion-Nano). */
    hf_repo_id?: string
    /** ``models_dir`` top-level pack vs ``generation-models/{tts,image}``. */
    pack_origin?: 'models_dir' | 'content_studio'
    /** Content Studio modality when this pack is a TTS or image generator. */
    content_studio_kind?: 'tts' | 'image'
  }
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserStatus {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface GpuDevice {
  kind: 'cpu' | 'cuda' | 'rocm' | 'metal' | 'vulkan' | 'npu'
  index: number
  name: string
  memory_mb?: number
}

export interface AgentStep {
  id: string
  kind: 'plan' | 'execute' | 'tool' | 'critic' | 'respond'
  title: string
  detail?: string
  status: 'pending' | 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  parentId?: string
}

export interface AgentRunRequest {
  model: string
  input: string
  systemPrompt?: string
  maxSteps?: number
}

export interface AgentRunResult {
  runId: string
  steps: AgentStep[]
  output: string
}

export interface ChatSession {
  id: string
  title: string
  modelId: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

export interface MemoryEntry {
  id: string
  kind: 'fact' | 'preference' | 'task' | 'decision'
  content: string
  createdAt: number
  score?: number
  /** Set when memory was created from a specific chat session (reflect, summary, /save). */
  sessionId?: string
}

export interface MemoryJanitorSettings {
  /** Trim session when message count exceeds this (default 30). */
  maxSessionMessages?: number
  /** Messages to keep after trim (default 20). */
  keepSessionMessages?: number
  /** Drop oldest memory rows when total exceeds this (default 500, 0 = off). */
  maxMemoryEntries?: number
  /** Drop memory older than N days (default 0 = off). */
  maxMemoryAgeDays?: number
}

export interface MemoryBundle {
  version: 1
  exportedAt: number
  profileId: string
  entries: MemoryEntry[]
}

export interface ProjectMemoryContext {
  /** Per-chat project folder (models save code/images/files here). */
  workspace: string
  projectDir?: string
  projectFileCount?: number
  workspaceEntries: MemoryEntry[]
  sessionEntries: MemoryEntry[]
}

export interface DecisionNode {
  id: string
  runId: string
  parentId?: string
  label: string
  detail?: string
  createdAt: number
}

export interface ContextBufferState {
  sessionId: string
  modelId: string
  tokenEstimate: number
  messageCount: number
  maxContext: number
}

export interface ToolInfo {
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'plugin'
  needsApproval?: boolean
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  tools: string[]
  enabled: boolean
}

/** Per-tensor quant override for llama-quantize --tensor-type (mixed precision in one GGUF). */
export interface TensorQuantOverride {
  /** Regex or glob tensor name pattern (e.g. blk.0.attn_q). */
  pattern: string
  /** ggml type name: q4_k, q8_0, f16, etc. */
  ggmlType: string
}

export interface QuantizeRequest {
  inputPath: string
  outputName: string
  quant: 'Q4_K_M' | 'Q5_K_M' | 'Q8_0' | 'F16'
  /** Mixed precision: maps to llama-quantize --tensor-type pattern=type */
  tensorTypes?: TensorQuantOverride[]
  /** Optional file with one pattern=type per line (--tensor-type-file). */
  tensorTypeFile?: string
}

export interface QuantizeProgress {
  status: string
  percent: number
  message: string
}

export interface DebugEvent {
  ts: number
  level: 'info' | 'warn' | 'error' | 'token'
  source: string
  message: string
  data?: unknown
}

export type UiThemeMode = 'dark' | 'light' | 'system' | 'custom'

/** User-customizable UI colors (hex or CSS color). */
export interface OmegaThemeColors {
  background?: string
  surface?: string
  surfaceElevated?: string
  border?: string
  text?: string
  textMuted?: string
  textHeading?: string
  accent?: string
  accentMuted?: string
  chatUserBg?: string
  chatUserText?: string
  chatAssistantBg?: string
  chatAssistantText?: string
  /** Highlighted values, metrics, tokens */
  value?: string
  codeBg?: string
  success?: string
  warning?: string
  error?: string
}

export interface OmegaConfig {
  homeDir: string
  modelsDir: string
  runtimePort: number
  defaultModel: string
  systemPrompt: string
  allowWebFetch: boolean
  /** In-app browser tab + browser_* agent tools (navigate, snapshot, stealth fetch). */
  allowBrowser?: boolean
  /**
   * Allow bundled omega-ollama to use Ollama cloud models (ollama.com remote inference).
   * Off by default — local pulls and GGUF imports only.
   */
  ollamaCloudEnabled?: boolean
  /** Fine-tune tab + finetune_* agent tools. */
  allowFinetune?: boolean
  /** Content Studio tab + content_* agent tools (bundled Media Automation backend). */
  allowContentStudio?: boolean
  /** Dev override: path to Media Automation sources; bundled copy is used when unset. */
  contentStudioPath?: string
  /** Shell commands and subprocess launch (run_shell, run_process). */
  allowShell: boolean
  /** read_file / write_file / list_dir outside the chat project folder (absolute paths). */
  allowHostFilesystem?: boolean
  sandboxRoot: string
  onboardingComplete: boolean
  maxContextTokens: number
  gpuLayers: number
  /** Auto-approve every tool invocation (skip approval prompts). */
  autoApproveTools: boolean
  /** Auto-approve agent self-extension (install_plugin, write_plugin, create_skill, extend_capability). */
  autoApproveSelfExtension?: boolean
  /** Auto-enable Settings permissions when the agent needs them (no in-chat permission card). */
  autoApproveCapabilities?: boolean
  /** Tools always allowed without approval prompt. */
  trustedTools: string[]
  /** Tool-approval strategy. */
  approvalMode?: ApprovalMode
  /** Active profile ID (default: "default"). */
  activeProfile?: string
  /** UI locale. */
  locale?: LocaleId
  /** Whether the floating 3D avatar is enabled. */
  avatarEnabled?: boolean
  /** Show File/Edit/… menu bar on Windows/Linux (default on). */
  showMenuBar?: boolean
  /**
   * When true (default on Windows/Linux), closing the main window hides to the tray
   * instead of quitting. Use tray → Quit to exit fully.
   */
  closeToTray?: boolean
  /** App chrome theme. */
  uiTheme?: UiThemeMode
  /** Custom palette when uiTheme is `custom`. */
  themeColors?: OmegaThemeColors
  /** Base preset when uiTheme is `custom` (default dark). */
  themeBase?: 'dark' | 'light'
  /**
   * HuggingFace access token. Required to download gated models (Llama, Gemma,
   * some Mistral / Qwen variants). Create one at https://huggingface.co/settings/tokens
   * (read-only is enough). Falls back to the HF_TOKEN env var if unset.
   */
  hfToken?: string
  /** HTTPS URL or local path to app update manifest (version, url, notes). */
  updateManifestUrl?: string
  /** Flash attention for chat vs Content Studio generation (separate toggles). */
  gpuAttention?: GpuAttentionSettings
  /** Default speculative / MTP settings for new models (overridable per model). */
  speculativeDecoding?: SpeculativeDecodingConfig
  /**
   * UI performance preset: lower default max_tokens, slightly smaller context cap,
   * fewer agent tool rounds. Does not disable features.
   */
  performanceMode?: boolean
  /**
   * LLM orchestrator pipeline node (prompt addendum, context rules). Default on.
   */
  llmOrchestrator?: boolean
  /**
   * Advanced two-phase PROMPT_1 → PROMPT_2 omega_turn planning. Off by default;
   * agent mode uses the universal multi-format tool loop for all model families.
   */
  llmOrchestratorTwoPhase?: boolean
  /** Active input pipeline for chat agent turns. */
  activeChatPipelineId?: string
  /** Active input pipeline for Content Studio agent turns. */
  activeContentPipelineId?: string
  /** Chat attachments & rich message options. */
  chat?: {
    maxAttachmentMb?: number
    maxAttachments?: number
    /** Default completion cap for chat (Settings or performance preset). */
    maxTokens?: number
  }
  /** Image generation tool backends (see image-generate service). */
  imageGeneration?: {
    /** Prefer Ollama when the loaded chat model is an Ollama image model (optional). */
    useOllama?: boolean
    /** Ollama image model tag when the chat model is an Ollama image backend (e.g. flux). */
    ollamaModel?: string
    /** Try OpenAI-compatible /v1/images/generations on configured providers. */
    useProviders?: boolean
    /** Output width for ``image_generate`` (0 = 1024). */
    width?: number
    /** Output height for ``image_generate`` (0 = 1024). */
    height?: number
  }
  /** Assistant voice, Content Studio defaults, media library (Settings → Omega tools). */
  omegaTools?: OmegaToolsSettings
  /** Post-chat reflection + self-improve log. */
  selfImproveEnabled?: boolean
  /** Session + memory cleanup rules (Settings → Memory janitor). */
  memoryJanitor?: MemoryJanitorSettings
}

export type InferencePhase = 'idle' | 'prefill' | 'decode' | 'retrieval' | 'tool'

export interface GpuTelemetry {
  index: number
  name: string
  vramUsedMb: number
  vramTotalMb: number
  utilizationPct?: number
  temperatureC?: number
}

export interface HardwareTelemetry {
  ts: number
  cpu: {
    loadAvg: number[]
    cores: number
    model: string
  }
  ram: {
    totalMb: number
    usedMb: number
    freeMb: number
    pressure: number
  }
  gpus: GpuTelemetry[]
}

/** llama.cpp b9247 speculative decoding (--spec-type draft-mtp, etc.). */
export type SpeculativeType = 'none' | 'draft-simple' | 'draft-mtp' | 'draft-eagle3' | 'ngram-simple'

export interface SpeculativeDecodingConfig {
  /** Enable speculative / MTP decoding when the backend supports it. */
  enabled?: boolean
  /** Defaults to draft-mtp when enabled and types omitted. */
  types?: SpeculativeType[]
  /** Separate draft GGUF; empty = same file as main model (typical for MTP). */
  draftModelPath?: string
  /** Max draft tokens per step (--spec-draft-n-max). */
  nMax?: number
  nMin?: number
  pMin?: number
}

export interface ModelConfig {
  contextSize: number
  /** Number of layers offloaded to GPU; remaining stay on CPU/RAM. 999 = all. */
  gpuLayers: number
  /** Eval batch size (tokens per pass). */
  batchSize?: number
  /** CPU threads. 0 = auto. */
  threads?: number
  /** Use memory-mapping (faster load, lower RAM use). */
  useMmap?: boolean
  /** Lock model in RAM (avoid swap). Requires permissions. */
  useMlock?: boolean
  /** Keep KV cache on GPU (faster, more VRAM). */
  kvCacheOnGpu?: boolean
  /** K cache quantization. */
  kCacheType?: 'f32' | 'f16' | 'q8_0' | 'q4_0'
  /** V cache quantization. */
  vCacheType?: 'f32' | 'f16' | 'q8_0' | 'q4_0'
  /** Sampling seed (-1 = random). */
  seed?: number
  /**
   * Chat attention override (inherits Settings → Performance ``chatMode`` when unset).
   * ``flash`` maps to llama.cpp flash attention; ``auto`` uses native kernels.
   */
  attentionMode?: GpuAttentionMode
  /** @deprecated Use ``attentionMode``. */
  flashAttention?: boolean
  ropeFreqBase?: number
  systemPrompt?: string
  chatTemplate?: string
  /**
   * Index of the GPU to use as "main" when multiple GPUs are present
   * (small tensors and the KV cache live here). 0 = first GPU.
   */
  mainGpu?: number
  /**
   * Fraction of the model to place on each GPU when splitting across multiple
   * devices. Example: [0.5, 0.5] splits evenly across 2 GPUs.
   * Empty / undefined = single-GPU on `mainGpu`.
   */
  tensorSplit?: number[]
  /**
   * Force a specific llama.cpp backend. 'auto' picks the build default;
   * 'vulkan' is required to combine AMD + NVIDIA cards in one model.
   */
  gpuBackend?: 'auto' | 'cuda' | 'vulkan' | 'metal' | 'cpu'
  speculative?: SpeculativeDecodingConfig
  /**
   * Chain-of-thought / thinking tokens (Qwen3, DeepSeek-R1, etc.).
   * Undefined = auto-detect from model id. `fastResponse` forces this off.
   */
  enableThinking?: boolean
  /** Shorter replies: disables thinking, lower max_tokens, slightly lower temperature. */
  fastResponse?: boolean
  /** GGUF LoRA adapters applied when this model is loaded (native backend). */
  adapters?: ModelAdapterEntry[]
}

/** Hugging Face LoRA / adapter attached to a base model. */
export interface ModelAdapterEntry {
  repoId: string
  /** Weight file inside the repo (e.g. ``lora.safetensors``). */
  file: string
  /** Blend strength (typical 0.5–1.2). Default 1. */
  scale?: number
}

/** Image LoRA paired with a base text-to-image repo (Content Studio). */
/** Width/height override for diffusers image models (Content Studio). */
export interface ImageSizeOverride {
  width: number
  height: number
}

export interface ImageModelAdapterEntry {
  baseRepoId: string
  adapterRepoId: string
  adapterFile?: string
  scale?: number
}

export interface HFSearchOptions {
  query?: string
  author?: string
  tag?: string
  sort?: 'downloads' | 'likes' | 'lastModified' | 'trending'
  limit?: number
  /** Weight format filter; 'any' = no format constraint. */
  format?: WeightFormat | 'any'
  /** Hugging Face pipeline_tag (official task), e.g. text-to-video. */
  pipelineTag?: string
  /** Backwards-compat alias for { format: 'gguf' }. */
  ggufOnly?: boolean
  /**
   * If true, results are restricted to a curated set of high-quality GGUF
   * re-quantizer accounts (lmstudio-community, bartowski, Qwen, unsloth,
   * mradermacher, TheBloke, etc.). Defaults to true when format='gguf' and
   * no explicit author is set — same behaviour as LM Studio's main browse.
   */
  verifiedOnly?: boolean
}

export interface ModelMetadata {
  id: string
  totalLayers?: number
  contextLengthMax?: number
  embeddingLength?: number
  parameterCount?: number
  fileSize: number
  architecture?: string
  quantization?: string
}

export interface MemoryEstimate {
  gpuMb: number
  cpuRamMb: number
  totalMb: number
  perLayerMb: number
  kvCacheMb: number
  /** Fits in total GPU VRAM (manual / card capacity). */
  fitsInGpu: boolean
  /** When a VRAM budget is supplied to the estimator, whether the config fits within it. */
  fitsInBudget?: boolean
  gpuBudgetMb?: number
}

export interface HFSearchResult {
  id: string
  modelId: string
  author: string
  downloads: number
  likes: number
  lastModified: string
  tags: string[]
  pipeline?: string
}

export interface HFFile {
  path: string
  size: number
  quant?: string
  /** Detected weight format. */
  format: WeightFormat
  /** True if Omega can load this file in-process (GGUF). */
  nativeSupported: boolean
}

export interface HFModelCard {
  id: string
  description: string
  files: HFFile[]
  tags: string[]
  pipeline?: string
  downloads: number
  likes: number
  readme?: string
}

/* ----------------------------- Workflows ----------------------------- */

export type WorkflowNode =
  | {
      id: string
      kind: 'prompt'
      label: string
      prompt: string
      system?: string
      model?: string
      maxTokens?: number
      temperature?: number
      output?: string
      continueOnError?: boolean
    }
  | {
      id: string
      kind: 'tool'
      label: string
      tool: string
      args?: Record<string, string>
      output?: string
      continueOnError?: boolean
    }
  | {
      id: string
      kind: 'agent'
      label: string
      input: string
      model?: string
      maxSteps?: number
      output?: string
      continueOnError?: boolean
    }
  | {
      id: string
      kind: 'branch'
      label: string
      condition: string
      output?: string
      continueOnError?: boolean
    }
  | {
      id: string
      kind: 'set'
      label: string
      value: string
      output?: string
      continueOnError?: boolean
    }

export interface WorkflowEdge {
  from: string
  to: string
  whenOutput?: string
}

export interface Workflow {
  id: string
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /** Visual editor positions keyed by node id. */
  layout?: Record<string, { x: number; y: number }>
  updatedAt: number
}

export interface FinetuneDatasetEntry {
  id: string
  name: string
  trainPath: string
  sampleCount: number
  createdAt: number
  modality?: FinetuneModality
}

export interface FinetuneDatasetPreset {
  id: string
  name: string
  sources: string[]
  modality: FinetuneModality
  format: FinetuneDatasetSpec['format']
  createdAt: number
}

export interface FinetuneSourceInspect {
  path: string
  exists: boolean
  kind: 'file' | 'directory' | 'missing'
  sizeBytes?: number
  extension?: string
  estimatedRows?: number
  hint?: string
}

export type WorkflowRunEvent =
  | { runId: string; kind: 'start'; workflowId?: string; at: number; seq?: number }
  | { runId: string; kind: 'nodeStart'; nodeId: string; label?: string; at: number; seq?: number }
  | { runId: string; kind: 'nodeDone'; nodeId: string; output?: string; at: number; seq?: number }
  | { runId: string; kind: 'nodeError'; nodeId: string; error: string; at: number; seq?: number }
  | { runId: string; kind: 'done'; at: number; output?: string; seq?: number }
  | { runId: string; kind: 'error'; error: string; workflowId?: string; at: number; seq?: number }
  | { runId: string; kind: 'aborted'; error?: string; workflowId?: string; at: number; seq?: number }

export interface WorkflowActiveRun {
  runId: string
  workflowId: string
  startedAt: number
}

export interface WorkflowRunResult {
  ok?: boolean
  started?: boolean
  async?: boolean
  runId?: string
  error?: string
  outputs?: Record<string, string>
  vars?: Record<string, string>
}

export type TerminalLineKind = 'info' | 'stdout' | 'stderr' | 'cmd' | 'error' | 'ok'

export interface TerminalLine {
  id: string
  at: number
  kind: TerminalLineKind
  text: string
  /** When true, Chat terminal panel should auto-expand (live event payload). */
  expand?: boolean
}

/* ------------------------------ RAG ------------------------------ */

export interface RagSource {
  source: string
  chunks: number
}

export interface RagHit {
  source: string
  chunkIdx: number
  content: string
  score: number
}

export interface RagStatus {
  sources: number
  embeddedChunks: number
  embedReady: boolean
  activeModel: string
  defaultModel: string
  embedError?: string | null
  hint?: string | null
}

export interface RagIndexFileResult {
  chunks: number
  embedded: number
}

export interface RagIndexDirResult {
  files: number
  chunks: number
  embedded: number
  error?: string
}

export interface ToolApprovalRequest {
  id: string
  tool: string
  args: Record<string, string>
  rationale?: string
  /** extension = agent self-extension (plugin/skill); shown in chat. general = modal overlay. */
  kind?: 'extension' | 'general'
  /** Human-readable one-liner for extension approvals. */
  summary?: string
  /** Extra context shown in the chat approval card. */
  detail?: string
}

export type CapabilityId =
  | 'web_fetch'
  | 'browser'
  | 'shell'
  | 'host_filesystem'
  | 'finetune'
  | 'content_studio'

export interface CapabilityPermissionRequest {
  id: string
  capability: CapabilityId
  tool: string
  args: Record<string, string>
  label: string
  summary: string
  detail: string
  settingsHint: string
}

export type ApprovalMode = 'smart' | 'always' | 'off'

export interface Skill {
  id: string
  name: string
  description: string
  category?: string
  path: string
  enabled: boolean
  contentPreview?: string
  tags?: string[]
}

export interface SkillContent extends Skill {
  body: string
}

export interface Profile {
  id: string
  name: string
  homeDir: string
  isActive: boolean
  isDefault: boolean
  modelCount?: number
  sessionCount?: number
  createdAt: number
}

export interface Soul {
  identity: string
  values: string
  style: string
  goals: string
}

export type CronFrequency =
  | { kind: 'minutes'; every: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dayOfWeek: number; hour: number; minute: number }
  | { kind: 'custom'; cron: string }

export type CronDeliveryTarget =
  | { kind: 'memory' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'webhook'; url: string }
  | { kind: 'notification' }

export interface CronJob {
  id: string
  name: string
  prompt: string
  modelId: string
  frequency: CronFrequency
  delivery: CronDeliveryTarget[]
  enabled: boolean
  agentMode: boolean
  skills: string[]
  nextRunAt: number
  lastRunAt?: number
  lastStatus?: 'ok' | 'error'
  lastError?: string
  createdAt: number
}

export type McpTransport =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string> }

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  description?: string
}

export interface McpServerStatus {
  id: string
  state: 'stopped' | 'starting' | 'ready' | 'error'
  error?: string
  toolCount: number
  resourceCount: number
}

export interface RemoteProvider {
  id: string
  name: string
  kind: 'openai' | 'anthropic' | 'ollama' | 'lmstudio' | 'custom-openai'
  baseUrl: string
  apiKey?: string
  /** Optional default model id to expose. */
  defaultModel?: string
  /** Explicit list of model IDs exposed by this provider. If empty, query at runtime. */
  models?: string[]
  enabled: boolean
  /** Headers to attach to every request. */
  headers?: Record<string, string>
}

export type GatewayPlatformId =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | 'signal'
  | 'matrix'
  | 'mattermost'
  | 'email'
  | 'sms'
  | 'webhook'
  | 'bluebubbles'
  | 'dingtalk'
  | 'feishu'
  | 'wecom'
  | 'weixin'
  | 'homeassistant'

export interface GatewayPlatformConfig {
  id: GatewayPlatformId
  enabled: boolean
  /** Free-form key/value config for the platform. */
  fields: Record<string, string>
  /** Default model id to use for replies; falls back to global default. */
  modelId?: string
  /** Allow agent mode (tools + memory). */
  agentMode?: boolean
  /** Trigger pattern: only reply when message matches (regex). */
  trigger?: string
  /** Allow list of senders (usernames / ids). Empty = anyone. */
  allowList?: string[]
}

export interface GatewayStatus {
  id: GatewayPlatformId
  running: boolean
  lastEvent?: string
  lastError?: string
  messagesIn: number
  messagesOut: number
}

export interface PluginManifest {
  id: string
  name: string
  description: string
  version: string
  author?: string
  homepage?: string
  /** Names of tools registered by this plugin. */
  tools?: string[]
  /** Required permissions for review. */
  permissions?: string[]
  /** Entry-point relative path inside the plugin dir. */
  entry?: string
}

export interface PluginCatalogEntry extends PluginManifest {
  /** Source URL — HTTP zip or git repo to install from. */
  source: string
  installed: boolean
  enabled?: boolean
}

export type LocaleId = 'en' | 'es' | 'pt-BR' | 'zh-CN' | 'ja' | 'fr'

export type KanbanStatus = 'backlog' | 'ready' | 'doing' | 'done' | 'blocked'

export interface KanbanTask {
  id: string
  title: string
  body: string
  status: KanbanStatus
  priority: 'low' | 'normal' | 'high' | 'urgent'
  assignee: 'agent' | 'user'
  skills: string[]
  modelId?: string
  workspace?: string
  result?: string
  error?: string
  /** Shown on Omega Office monitor wall when set. */
  monitorUrl?: string
  /** Pinned on Office floor plan sidebar. */
  officePinned?: boolean
  /** Linked workforce run id when dispatched via Office/Kanban bridge. */
  officeRunId?: string
  createdAt: number
  updatedAt: number
  runStartedAt?: number
  runEndedAt?: number
}

/** Fine-tuning task / modality. */
export type FinetuneModality =
  | 'instruction'
  | 'conversational'
  | 'chatml'
  | 'alpaca'
  | 'image_to_text'
  | 'text_to_image'
  | 'embedding'
  | 'completion'

export type FinetuneJobStatus =
  | 'draft'
  | 'preparing'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface FinetuneHyperparams {
  epochs: number
  learningRate: number
  batchSize: number
  gradientAccumulation: number
  maxSeqLength: number
  loraRank: number
  loraAlpha: number
  warmupRatio: number
  saveSteps: number
  /** Modality-specific extras (e.g. resolution for vision). */
  extras?: Record<string, number | string | boolean>
}

export interface FinetuneDatasetSpec {
  /** Raw file paths or directories the user selected. */
  sources: string[]
  /** After formatting: path to train JSONL. */
  trainPath?: string
  evalPath?: string
  format: 'auto' | 'jsonl' | 'csv' | 'folder'
  sampleCount?: number
  preview?: string
}

export interface FinetuneModelProfile {
  modelId: string
  architecture?: string
  parameterCount?: number
  suggestedModalities: FinetuneModality[]
  primaryModality: FinetuneModality
  hyperparams: FinetuneHyperparams
  notes: string[]
  supportsTraining: boolean
  trainerBackend: 'unsloth' | 'peft' | 'diffusers' | 'prepare-only'
}

export interface FinetuneJob {
  id: string
  name: string
  modelId: string
  modality: FinetuneModality
  status: FinetuneJobStatus
  hyperparams: FinetuneHyperparams
  dataset: FinetuneDatasetSpec
  outputDir: string
  adapterPath?: string
  mergedModelPath?: string
  percent: number
  message: string
  log: string[]
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
}

export interface FinetuneStartRequest {
  name?: string
  modelId: string
  modality?: FinetuneModality
  hyperparams?: Partial<FinetuneHyperparams>
  dataset: FinetuneDatasetSpec
  dryRun?: boolean
}

export interface FinetuneProgress {
  jobId: string
  status: FinetuneJobStatus
  percent: number
  message: string
  line?: string
}

export interface FinetunePrepareDatasetRequest {
  modelId: string
  modality: FinetuneModality
  sources: string[]
}

/** Content Studio (Media Automation) — projects, generation runs, schedules. */
export interface ContentStudioProject {
  id: string
  title: string
  theme: string
  status: string
  updated_at?: string
}

export interface ContentStudioRun {
  job_id: string
  project_id: string
  status: string
  poll_url: string
  content_url: string
}

export interface ContentStudioRunStatus {
  job_id: string
  project_id: string
  status: string
  worker_running?: boolean
  script_ready?: boolean
  video_ready?: boolean
  mp4_path?: string | null
  job_folder?: string | null
  /** Render step: images | tts | ffmpeg | done (from job payload while worker runs). */
  pipeline_phase?: string | null
  /** video | image_only | audio_only — when absent, video MP4 is expected for local_media runs. */
  deliverable?: string | null
  youtube_url?: string | null
  error_message?: string | null
  logs?: Array<{ level: string; message: string }>
}

export interface ContentSchedule {
  id: string
  project_id?: string | null
  series_id?: string | null
  cron_expression: string
  timezone: string
  is_active: boolean
  next_run?: string | null
  run_count?: number
}

export interface ContentSocialPlatform {
  id: string
  name: string
  connect_hint: string
}

export interface ContentSocialAccount {
  id: string
  platform: string
  account_label?: string | null
  external_id?: string | null
  is_active: boolean
}

export interface ContentSocialPost {
  id: string
  platform: string
  title: string
  caption?: string | null
  project_id?: string | null
  status: string
  published_url?: string | null
  error_message?: string | null
}

export interface ContentStudioStatus {
  available: boolean
  running: boolean
  /** On-demand workers ready (venv + migrations); no uvicorn required. */
  ready?: boolean
  /** `on-demand` (default) or `uvicorn` when OMEGA_CS_UVICORN=1. */
  mode?: 'on-demand' | 'uvicorn'
  /** True when backend/.venv exists (created on first launch if missing). */
  venvReady: boolean
  /** True when unified Python can import Content Studio stack (SQLAlchemy, etc.). */
  apiPackagesReady?: boolean
  /** True while first-time pip / venv setup is still running in the background. */
  setupRunning?: boolean
  /** Bundled data/content_studio scripts present next to omega.exe. */
  scriptsReady?: boolean
  /** FFmpeg available for final MP4 assembly. */
  ffmpegReady?: boolean
  /** torch + diffusers + qwen-tts importable in unified Python (local GPU render). */
  mediaPackagesReady?: boolean
  /** Alias for mediaPackagesReady — local PyTorch media stack ready. */
  localMediaReady?: boolean
  /** scripts + media packages + ffmpeg (when needed for video). */
  renderReady?: boolean
  scriptsDir?: string
  ffmpegBinDir?: string
  renderHint?: string | null
  port?: number
  baseUrl?: string
  error?: string
  repoPath: string
  lastJobUpdatedAt?: number
}

export type ContentStudioSetupStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped'
  | 'error'

export interface ContentStudioSetupStep {
  id: string
  label: string
  status: ContentStudioSetupStepStatus
  detail?: string
}

/** Progress snapshot while building the Content Studio Python environment. */
export interface ContentStudioSetupProgress {
  running: boolean
  steps: ContentStudioSetupStep[]
  percent: number
  error?: string
}

/** Stored in ~/.omega/content-studio-credentials.json and synced to the Python API. */
export type InputBuilderNodeKind =
  | 'user_input'
  | 'chat'
  | 'proxy'
  | 'adapter'
  | 'tts'
  | 'image'
  | 'bubble'

export interface InputBuilderNode {
  id: string
  kind: InputBuilderNodeKind
  label: string
  x?: number
  y?: number
  modelId?: string
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  config?: Record<string, unknown>
}

export interface InputBuilderEdge {
  from: string
  to: string
}

export interface InputBuilderFlow {
  id: string
  name: string
  description?: string
  nodes: InputBuilderNode[]
  edges: InputBuilderEdge[]
}

export interface ContentStudioGenerationSettings {
  scriptMode: 'content_studio' | 'omega_agent' | 'agent_orchestrated'
  /** Use omega-runtime native media (llama.cpp TTS + Ollama images + ffmpeg) when studio packs are not pinned. */
  preferNativeMedia?: boolean
  /** auto | edge | kokoro | qwen | silent */
  ttsProvider?: string
  /** auto | subtitle | flux | sdxl | sd15 | diffusers */
  imageProvider?: string
  /** Override models path — must be inside ~/.omega (e.g. ~/.omega/models/generation-models). */
  generationModelsDataDir?: string
  ttsRepoId?: string
  imageRepoId?: string
  omegaModelId?: string
  /** When false, chat model stays unloaded after a video job until the next message (saves VRAM). */
  reloadChatModelAfterJob?: boolean
  /** Per-repo inference steps override (0 = catalog default). */
  imageStepsByRepo?: Record<string, number>
  /** Per-repo text-to-video inference steps override (0 = catalog default). */
  videoStepsByRepo?: Record<string, number>
  /** Per-repo width/height (see ``ImageSizeOverride``). */
  imageSizeByRepo?: Record<string, ImageSizeOverride>
  /** Per-repo text-to-video width/height (see ``ImageSizeOverride``). */
  videoSizeByRepo?: Record<string, ImageSizeOverride>
  /** LoRA adapters for image generation pipelines. */
  imageAdapters?: ImageModelAdapterEntry[]
  /** Same as ``OmegaToolsSettings.contentStudioImageVramMode`` (synced from Settings). */
  imageVramMode?: 'all_gpu' | 'auto' | 'offload_encoders'
  /** Input-builder flow id for Content Studio media graph (default flow-content-default). */
  inputFlowId?: string
}

export interface ContentGenerationRecommendedAdapter {
  repo_id: string
  label?: string
  file?: string
  description?: string
}

export interface ContentGenerationModelEntry {
  key: string
  repo_id: string
  description: string
  size?: string
  on_disk?: boolean
  /** Catalog default steps when user override is 0. */
  default_num_steps?: number
  default_guidance_scale?: number
  default_width?: number
  default_height?: number
  default_num_frames?: number
  default_fps?: number
  /** Whether diffusers LoRA adapters can be stacked on this base model. */
  supports_adapters?: boolean
  recommended_adapters?: ContentGenerationRecommendedAdapter[]
}

/** One UI / pipeline knob discovered for a pinned generation model. */
export interface GenerationControl {
  id: string
  type: string
  label: string
  default?: string | number | boolean
  min?: number
  max?: number
  values?: string[]
  description?: string
  advanced?: boolean
}

/** Runtime probe for a user-pinned HF generation repo (from disk + backend family). */
export interface GenerationCapabilities {
  modality: 'tts' | 'image' | 'video'
  repo_id: string
  on_disk: boolean
  pack_origin?: string
  family: string
  engine: string
  generation_mode?: string | null
  pipeline_class?: string | null
  backend_supported: boolean
  constraints: Record<string, unknown>
  defaults: Record<string, unknown>
  controls: GenerationControl[]
  unsupported_reason?: string | null
  catalog_overlay?: Record<string, unknown> | null
}

export interface ContentGenerationCatalog {
  defaults: { tts: string; image: string; video?: string }
  /** Recommended downloads (one per modality in the default studio UI). */
  suggested_tts_models?: ContentGenerationModelEntry[]
  suggested_image_models?: ContentGenerationModelEntry[]
  suggested_video_models?: ContentGenerationModelEntry[]
  tts_models: ContentGenerationModelEntry[]
  image_models: ContentGenerationModelEntry[]
  video_models?: ContentGenerationModelEntry[]
  /** Models already on disk — user can pick any of these for a task. */
  installed_tts?: ContentGenerationModelEntry[]
  installed_image?: ContentGenerationModelEntry[]
  installed_video?: ContentGenerationModelEntry[]
  models_root?: string
  script_modes: string[]
  active: {
    tts: string
    image: string
    video?: string
    script_mode: string
    omega_model_id: string
  }
}

export interface ContentStudioCredentials {
  youtubeClientId?: string
  youtubeClientSecret?: string
  youtubeRefreshToken?: string
  youtubeUploadPrivacy?: 'public' | 'unlisted' | 'private'
  youtubeOAuthRedirectUri?: string
  metaAppId?: string
  metaAppSecret?: string
  metaAccessToken?: string
  metaPageId?: string
  instagramBusinessAccountId?: string
  tiktokClientKey?: string
  tiktokClientSecret?: string
  tiktokAccessToken?: string
  xApiKey?: string
  xApiSecret?: string
  xAccessToken?: string
  xAccessTokenSecret?: string
  linkedinClientId?: string
  linkedinClientSecret?: string
  linkedinAccessToken?: string
  /** Organization URN or numeric id for video UGC (e.g. urn:li:organization:123). */
  linkedinOrganizationId?: string
  linkedinOrganizationUrn?: string
}

export * from './load-progress.js'
export * from './model-id.js'
export * from './model-capabilities.js'
export * from './model-file-bundle.js'
export * from './hf-pipeline-tasks.js'
export * from './hf-search.js'
export * from './hf-search-filters.js'
export * from './hf-file-size.js'
export * from './ui-model-load.js'
export * from './engine-protocol.js'
export * from './plugin-protocol.js'
export * from './input-pipeline.js'
export * from './orchestrator-prompts.js'
export * from './orchestrator.js'
export * from './runtime-api.js'
export * from './session-media-url.js'
export * from './http-invoke.js'

export interface ContentSeries {
  id: string
  user_id: string
  title: string
  theme: string
  default_max_duration_seconds: number
  is_active: boolean
  next_episode_number?: number
  updated_at?: string
}
