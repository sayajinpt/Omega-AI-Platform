/**
 * Native engine command + event contract.
 *
 * UI talks to omega-runtime over HTTP; channel names below are stable SDK identifiers.
 */

/** Request envelope — every UI → engine call. */
export interface EngineCommandRequest<T extends EngineCommandType = EngineCommandType> {
  id: string
  type: T
  payload: EngineCommandPayload[T]
}

/** Response envelope — every engine → UI reply (non-streaming). */
export interface EngineCommandResponse<T extends EngineCommandType = EngineCommandType> {
  id: string
  type: T
  success: boolean
  data?: EngineCommandResult[T]
  error?: string
}

/** Push envelope — engine → UI (streaming / progress). */
export interface EngineEvent<T extends EngineEventType = EngineEventType> {
  type: T
  runId?: string
  at: number
  payload: EngineEventPayload[T]
}

/** All command types supported by omega-runtime. */
export type EngineCommandType =
  | 'health'
  | 'config.get'
  | 'config.set'
  | 'chat.send'
  | 'chat.abort'
  | 'chat.generate'
  | 'chat.embed'
  | 'model.list'
  | 'model.load'
  | 'model.unload'
  | 'model.loaded'
  | 'model.delete'
  | 'session.list'
  | 'session.create'
  | 'session.delete'
  | 'session.messages'
  | 'memory.search'
  | 'memory.add'
  | 'tool.list'
  | 'tool.run'
  | 'agent.run'
  | 'agent.abort'
  | 'office.start'
  | 'office.stop'
  | 'office.snapshot'
  | 'download.start'
  | 'download.cancel'
  | 'workflow.run'
  | 'workflow.abort'
  | 'plugin.list'
  | 'plugin.status'
  | 'plugin.toggle'
  | 'plugin.reload'
  | 'plugin.catalog'
  | 'plugin.install'
  | 'plugin.uninstall'
  | 'plugin.write'

/** Payload per command type. */
export type EngineCommandPayload = {
  health: Record<string, never>
  'config.get': Record<string, never>
  'config.set': { patch: Record<string, unknown> }
  'chat.send': {
    model: string
    messages: Array<{
      role: string
      content: string
      imagePaths?: string[]
      images?: string[]
    }>
    sampling?: { max_tokens?: number; temperature?: number; top_p?: number; top_k?: number }
    enableThinking?: boolean
  }
  'chat.abort': { sessionId?: string }
  'chat.generate': {
    model: string
    prompt: string
    sampling?: { max_tokens?: number; temperature?: number }
  }
  'chat.embed': { model: string; text: string }
  'model.list': Record<string, never>
  'model.load': {
    modelId: string
    gpu_layers?: number
    context_size?: number
    batch_size?: number
    threads?: number
    flash_attn?: number
    quant_policy?: string
    mmproj_path?: string
    mmprojPath?: string
    speculative?: {
      enabled?: boolean
      types?: string[]
      draft_model_path?: string
      draftModelPath?: string
      n_max?: number
      nMax?: number
      n_min?: number
      nMin?: number
      p_min?: number
      pMin?: number
    }
  }
  'model.unload': { modelId?: string }
  'model.loaded': Record<string, never>
  'model.delete': { modelId: string }
  'session.list': Record<string, never>
  'session.create': { title?: string; modelId?: string; systemPrompt?: string }
  'session.delete': { sessionId: string }
  'session.messages': { sessionId: string }
  'memory.search': { query: string; limit?: number }
  'memory.add': { kind: string; content: string }
  'tool.list': Record<string, never>
  'tool.run': { tool: string; args: Record<string, string> }
  'agent.run': { model: string; input: string; maxSteps?: number }
  'agent.abort': Record<string, never>
  'office.start': Record<string, never>
  'office.stop': Record<string, never>
  'office.snapshot': Record<string, never>
  'download.start': { url: string; dest?: string }
  'download.cancel': { downloadId: string }
  'workflow.run': { workflowId: string; vars?: Record<string, string>; model?: string }
  'workflow.abort': { runId?: string }
  'plugin.list': Record<string, never>
  'plugin.status': Record<string, never>
  'plugin.toggle': { id: string; enabled: boolean }
  'plugin.reload': Record<string, never>
  'plugin.catalog': Record<string, never>
  'plugin.install': { source: 'builtin' | 'url'; id?: string; url?: string }
  'plugin.uninstall': { id: string }
  'plugin.write': {
    pluginId: string
    name: string
    description: string
    version?: string
    permissions?: string[]
    tools: Array<{ name: string; description?: string; permissions?: string[] }>
    source: string
  }
}

/** Result data per command type. */
export type EngineCommandResult = {
  health: {
    ok: boolean
    version: string
    infer_available?: boolean
    infer_server?: boolean
    speculative?: boolean
    vision?: boolean
    paging?: boolean
    dispatch_latency_ms?: number
    dispatch_latency_max_ms?: number
    inference_queue_depth?: number
    inference_busy?: boolean
    service_pool_workers?: number
    service_pool_running?: number
    service_pool_queued?: number
    service_pool_max?: number
    database?: {
      path: string
      journal_mode: string
      memory_rows: number
      session_rows: number
      vector_rows: number
      rag_chunk_rows: number
    }
  }
  'config.get': { config: Record<string, unknown> }
  'config.set': { config: Record<string, unknown> }
  'chat.send': { text: string }
  'chat.abort': { aborted: boolean }
  'chat.generate': { text: string }
  'chat.embed': { vector: number[] }
  'model.list': { models: unknown[] }
  'model.load': { modelId: string; loaded: boolean }
  'model.unload': { unloaded: boolean }
  'model.loaded': { models: string[]; activeModelId?: string }
  'model.delete': { deleted: boolean }
  'session.list': { sessions: unknown[] }
  'session.create': { session: unknown }
  'session.delete': { deleted: boolean }
  'session.messages': { messages: unknown[] }
  'memory.search': { hits: unknown[] }
  'memory.add': { id: string }
  'tool.list': { tools: unknown[] }
  'tool.run': { output: string }
  'agent.run': { output: string; steps?: unknown[] }
  'agent.abort': { aborted: boolean }
  'office.start': { running: boolean; port?: number }
  'office.stop': { running: boolean }
  'office.snapshot': { snapshot: unknown }
  'download.start': { downloadId: string }
  'download.cancel': { cancelled: boolean }
  'workflow.run': { runId: string; outputs?: Record<string, string> }
  'workflow.abort': { aborted: boolean }
  'plugin.list': { plugins: unknown[] }
  'plugin.status': { status: unknown }
  'plugin.toggle': { plugins: unknown[] }
  'plugin.reload': { plugins: unknown[] }
  'plugin.catalog': { catalog: unknown[] }
  'plugin.install': { manifest: unknown }
  'plugin.uninstall': { uninstalled: boolean }
  'plugin.write': { ok: boolean; output: string; pluginId?: string }
}

/** Hugging Face / bundle download progress (matches desktop download service). */
export interface EngineDownloadProgress {
  repo: string
  filename: string
  bytes_done: number
  bytes_total: number
  percent: number
  speed_bps: number
  status: string
}

/** Workflow runner live event (matches @omega/sdk WorkflowRunEvent). */
export type EngineWorkflowRunEvent =
  | { runId: string; kind: 'start'; workflowId?: string; at: number; seq?: number }
  | { runId: string; kind: 'nodeStart'; nodeId: string; label?: string; at: number; seq?: number }
  | { runId: string; kind: 'nodeDone'; nodeId: string; output?: string; at: number; seq?: number }
  | { runId: string; kind: 'nodeError'; nodeId: string; error: string; at: number; seq?: number }
  | { runId: string; kind: 'done'; at: number; output?: string; seq?: number }
  | { runId: string; kind: 'error'; error: string; workflowId?: string; at: number; seq?: number }
  | { runId: string; kind: 'aborted'; error?: string; workflowId?: string; at: number; seq?: number }

/** Streaming / progress event types. */
export type EngineEventType =
  | 'ModelLoaded'
  | 'ModelUnloaded'
  | 'ModelLoadProgress'
  | 'ChatStarted'
  | 'ChatChunkReceived'
  | 'ChatFinished'
  | 'ChatError'
  | 'StreamToken'
  | 'StreamMetrics'
  | 'StreamMedia'
  | 'StreamDone'
  | 'StreamError'
  | 'DownloadStarted'
  | 'DownloadProgress'
  | 'DownloadFinished'
  | 'AgentStep'
  | 'AgentToken'
  | 'OfficeReady'
  | 'OfficeChanged'
  | 'WorkflowNodeStart'
  | 'WorkflowNodeDone'
  | 'WorkflowNodeError'
  | 'WorkflowDone'
  | 'WorkflowRunProgress'
  | 'FinetuneProgress'
  | 'ContentStudioSetupProgress'
  | 'QuantizeProgress'

export type EngineEventPayload = {
  ModelLoaded: { modelId: string }
  ModelUnloaded: { modelId: string }
  ModelLoadProgress: { modelId: string; phase: string; detail?: string; percent: number }
  ChatStarted: { sessionId: string; model: string }
  ChatChunkReceived: { sessionId: string; text: string; index?: number }
  ChatFinished: { sessionId: string; text: string }
  ChatError: { sessionId: string; error: string }
  StreamToken: { streamId: string; token: { text: string; index?: number } }
  StreamMetrics: { streamId: string; metrics: Record<string, unknown> }
  StreamMedia: { streamId: string; part: Record<string, unknown> }
  StreamDone: { streamId: string; result: Record<string, unknown> }
  StreamError: { streamId: string; error: string }
  DownloadStarted: { downloadId: string; url: string }
  DownloadProgress: EngineDownloadProgress
  DownloadFinished: { downloadId: string; path: string }
  AgentStep: { step: unknown }
  AgentToken: { text: string; index?: number }
  OfficeReady: { port: number }
  OfficeChanged: { snapshot: unknown }
  WorkflowNodeStart: { runId: string; nodeId: string; label?: string }
  WorkflowNodeDone: { runId: string; nodeId: string; output?: string }
  WorkflowNodeError: { runId: string; nodeId: string; error: string }
  WorkflowDone: { runId: string; outputs?: Record<string, string> }
  WorkflowRunProgress: EngineWorkflowRunEvent
  FinetuneProgress: {
    jobId: string
    status: string
    percent: number
    message: string
    line?: string
  }
  ContentStudioSetupProgress: {
    running: boolean
    steps: Array<{ id: string; label: string; status: string; detail?: string }>
    percent: number
    error?: string
  }
  QuantizeProgress: { status: string; percent: number; message: string }
}

/** Maps SDK channel name → engine command type. */
export const IPC_TO_ENGINE_COMMAND: Partial<Record<string, EngineCommandType>> = {
  'omega:config:get': 'config.get',
  'omega:config:set': 'config.set',
  'omega:chat:send': 'chat.send',
  'omega:chat:abort': 'chat.abort',
  'omega:generate': 'chat.generate',
  'omega:embed': 'chat.embed',
  'omega:models:list': 'model.list',
  'omega:models:load': 'model.load',
  'omega:models:unload': 'model.unload',
  'omega:models:delete': 'model.delete',
  'omega:sessions:list': 'session.list',
  'omega:sessions:create': 'session.create',
  'omega:sessions:delete': 'session.delete',
  'omega:sessions:messages': 'session.messages',
  'omega:memory:search': 'memory.search',
  'omega:memory:add': 'memory.add',
  'omega:tools:list': 'tool.list',
  'omega:tools:run': 'tool.run',
  'omega:agent:run': 'agent.run',
  'omega:agent:abort': 'agent.abort',
  'omega:office:visualization:start': 'office.start',
  'omega:office:visualization:stop': 'office.stop',
  'omega:office:snapshot': 'office.snapshot',
  'omega:workflows:run': 'workflow.run',
  'omega:workflows:abort': 'workflow.abort',
  'omega:plugins:list': 'plugin.list',
  'omega:plugins:toggle': 'plugin.toggle',
  'omega:plugins:reload': 'plugin.reload',
  'omega:plugins:catalog': 'plugin.catalog',
  'omega:plugins:installBuiltin': 'plugin.install',
  'omega:plugins:installUrl': 'plugin.install',
  'omega:plugins:uninstall': 'plugin.uninstall'
}

/** Maps engine stream events → SDK event channel names. */
export const ENGINE_EVENT_TO_IPC: Partial<Record<EngineEventType, string>> = {
  ChatChunkReceived: 'omega:stream:token',
  // ChatFinished is handled in-process by EngineClient; stream completion IPC comes from StreamDone only.
  ChatError: 'omega:stream:error',
  StreamToken: 'omega:stream:token',
  StreamMetrics: 'omega:stream:metrics',
  StreamMedia: 'omega:stream:media',
  StreamDone: 'omega:stream:done',
  StreamError: 'omega:stream:error',
  ModelLoadProgress: 'omega:models:load-progress',
  DownloadProgress: 'omega:download:progress',
  AgentStep: 'omega:agent:step',
  AgentToken: 'omega:agent:token',
  OfficeChanged: 'omega:office:changed',
  WorkflowNodeStart: 'omega:workflows:event',
  WorkflowNodeDone: 'omega:workflows:event',
  WorkflowNodeError: 'omega:workflows:event',
  WorkflowDone: 'omega:workflows:event',
  WorkflowRunProgress: 'omega:workflows:event',
  FinetuneProgress: 'omega:finetune:progress',
  ContentStudioSetupProgress: 'omega:content-studio:setupProgress',
  QuantizeProgress: 'omega:quantize:progress'
}
