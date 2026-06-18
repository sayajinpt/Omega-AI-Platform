/** HTTP routes for the native C++ omega-runtime. */

export const DEFAULT_NATIVE_RUNTIME_PORT = 9877
export const DEFAULT_NATIVE_RUNTIME_HOST = '127.0.0.1'

/** Core routes implemented in omega-runtime. */
export const RUNTIME_HTTP_ROUTES = {
  health: '/healthz',
  runtimeInfo: '/v1/runtime/info',
  runtimeRoutes: '/v1/runtime/routes',
  runtimeStatus: '/v1/runtime/status',
  config: '/v1/config',
  models: '/v1/models',
  modelsLoaded: '/v1/models/loaded',
  modelsLoad: '/v1/models/load',
  modelsUnload: '/v1/models/unload',
  engineCommand: '/v1/engine/command',
  enginesStatus: '/v1/engines/status',
  inferenceBackends: '/v1/inference/backends',
  pythonStatus: '/v1/python/status',
  pythonSetup: '/v1/python/setup',
  chatSend: '/v1/chat/send',
  chatAbort: '/v1/chat/abort',
  chatStreamPoll: '/v1/chat/stream/poll',
  eventsPoll: '/v1/events/poll',
  eventsSse: '/v1/events/sse',
  workflowsRun: '/v1/workflows/run',
  workflowsAbort: '/v1/workflows/abort',
  cronRunNow: '/v1/cron/runNow',
  kanbanDispatch: '/v1/kanban/dispatch',
  providersList: '/v1/providers/list',
  providersSave: '/v1/providers/save',
  providersDelete: '/v1/providers/delete',
  providersFetchModels: '/v1/providers/fetchModels',
  providersPresets: '/v1/providers/presets',
  providersDiscover: '/v1/providers/discover',
  inputPipelinesList: '/v1/input-pipelines/list',
  inputPipelinesGet: '/v1/input-pipelines/get',
  inputPipelinesSave: '/v1/input-pipelines/save',
  inputPipelinesDelete: '/v1/input-pipelines/delete',
  inputPipelinesSetActive: '/v1/input-pipelines/set-active',
  contextBuffer: '/v1/context/buffer',
  pluginsList: '/v1/plugins/list',
  pluginsCatalog: '/v1/plugins/catalog',
  pluginsToggle: '/v1/plugins/toggle',
  pluginsReload: '/v1/plugins/reload',
  pluginsInstallBuiltin: '/v1/plugins/installBuiltin',
  pluginsInstallUrl: '/v1/plugins/installUrl',
  pluginsUninstall: '/v1/plugins/uninstall',
  mcpList: '/v1/mcp/list',
  mcpSave: '/v1/mcp/save',
  mcpDelete: '/v1/mcp/delete',
  mcpStatus: '/v1/mcp/status',
  mcpStart: '/v1/mcp/start',
  mcpStop: '/v1/mcp/stop',
  mcpOmega: '/v1/mcp',
  ollamaStart: '/v1/engines/ollama/start',
  ollamaStop: '/v1/engines/ollama/stop',
  ollamaList: '/v1/engines/ollama/list',
  ollamaPull: '/v1/engines/ollama/pull',
  gatewayPlatforms: '/v1/gateway/platforms',
  gatewayList: '/v1/gateway/list',
  gatewaySave: '/v1/gateway/save',
  gatewayDelete: '/v1/gateway/delete',
  gatewayStart: '/v1/gateway/start',
  gatewayStop: '/v1/gateway/stop',
  gatewayStatus: '/v1/gateway/status',
  inferenceBackend: '/v1/inference/backend',
  inferenceSwitch: '/v1/inference/switch',
  inferenceMediaCapabilities: '/v1/inference/media/capabilities',
  contentStudioNativeRender: '/v1/content-studio/native/render',
  sessionsMedia: '/v1/sessions/media',
  contentStudioJobMedia: '/v1/content-studio/jobMedia',
  projectOpen: '/v1/project/open',
  projectList: '/v1/project/list',
  pipelineActivity: '/v1/pipeline/activity',
  debugHistory: '/v1/debug/history',
  contentStudioStatus: '/v1/content-studio/status',
  contentStudioStart: '/v1/content-studio/start',
  contentStudioStop: '/v1/content-studio/stop',
  contentStudioRestart: '/v1/content-studio/restart',
  contentStudioProjects: '/v1/content-studio/projects',
  contentStudioCreateRun: '/v1/content-studio/createRun',
  contentStudioRunStatus: '/v1/content-studio/runStatus',
  contentStudioForceStopJob: '/v1/content-studio/forceStopJob',
  contentStudioSchedules: '/v1/content-studio/schedules',
  contentStudioScheduleCreate: '/v1/content-studio/scheduleCreate',
  contentStudioScheduleDelete: '/v1/content-studio/scheduleDelete',
  contentStudioSocialPlatforms: '/v1/content-studio/socialPlatforms',
  contentStudioSocialAccounts: '/v1/content-studio/socialAccounts',
  contentStudioSocialPosts: '/v1/content-studio/socialPosts',
  contentStudioSocialPublish: '/v1/content-studio/socialPublish',
  contentStudioCredentialsGet: '/v1/content-studio/credentialsGet',
  contentStudioCredentialsSet: '/v1/content-studio/credentialsSet',
  contentStudioCredentialsSync: '/v1/content-studio/credentialsSync',
  contentStudioCredentialsStatus: '/v1/content-studio/credentialsStatus',
  contentStudioSeriesList: '/v1/content-studio/seriesList',
  contentStudioSeriesCreate: '/v1/content-studio/seriesCreate',
  contentStudioSeriesDelete: '/v1/content-studio/seriesDelete',
  contentStudioGenerationGet: '/v1/content-studio/generationGet',
  contentStudioGenerationSet: '/v1/content-studio/generationSet',
  contentStudioGenerationCatalog: '/v1/content-studio/generationCatalog',
  contentStudioGenerationCapabilities: '/v1/content-studio/generationCapabilities',
  modelConfigList: '/v1/model-config/list',
  modelConfigGet: '/v1/model-config/get',
  modelConfigSet: '/v1/model-config/set',
  modelConfigReset: '/v1/model-config/reset',
  finetuneList: '/v1/finetune/list',
  finetuneGet: '/v1/finetune/get',
  finetuneCreate: '/v1/finetune/create',
  finetuneDelete: '/v1/finetune/delete',
  finetuneStart: '/v1/finetune/start',
  finetuneAbort: '/v1/finetune/abort',
  finetuneAnalyze: '/v1/finetune/analyze',
  finetunePrepareDataset: '/v1/finetune/prepareDataset',
  finetuneListDatasets: '/v1/finetune/listDatasets',
  finetuneListPresets: '/v1/finetune/listPresets',
  finetuneSavePreset: '/v1/finetune/savePreset',
  finetuneDeletePreset: '/v1/finetune/deletePreset',
  finetuneInspectSource: '/v1/finetune/inspectSource',
  finetunePickSources: '/v1/finetune/pickSources',
  finetuneDatasetsRoot: '/v1/finetune/datasetsRoot',
  finetuneDeletePrepared: '/v1/finetune/deletePrepared',
  modelPresetsList: '/v1/model-presets/list',
  modelPresetsApply: '/v1/model-presets/apply',
  modelInspect: '/v1/model/inspect',
  modelEstimate: '/v1/model/estimate',
  modelEstimateFile: '/v1/model/estimateFile',
  modelsFootprint: '/v1/models/footprint',
  modelsBenchmark: '/v1/models/benchmark',
  modelsCheckHfAccess: '/v1/models/check-hf-access',
  modelsRepoFiles: '/v1/models/repo-files',
  modelsOpenHfRepo: '/v1/models/open-hf-repo',
  hfSearch: '/v1/hf/search',
  hfCard: '/v1/hf/card',
  hfTags: '/v1/hf/tags',
  gpuList: '/v1/gpu/list',
  memoryProjectContext: '/v1/memory/projectContext'
} as const

/** IPC channels with a direct HTTP mapping (generated from route catalog). */
export {
  IPC_HTTP_MAP,
  IPC_EVENT_CHANNELS,
  isIpcHttpChannel,
  type IpcHttpChannel
} from './ipc-http-map.generated'

export type NativeRuntimeCapabilities = {
  health: boolean
  config: boolean
  models: boolean
  engine_command: boolean
  chat: boolean
  sessions: boolean
  python_unified: boolean
}

export type NativeRuntimeInfo = {
  name: string
  version: string
  build_tag?: string
  omega_home: string
  transport: 'http'
  default_port: number
  route_catalog?: string
  route_summary?: RouteCatalogSummary
  engine_available?: boolean
  engine_error?: string
  capabilities: NativeRuntimeCapabilities
  notes?: string
}

export type RouteCatalogSummary = {
  total: number
  done: number
  partial: number
  planned: number
  by_target?: { cxx: number; python: number; ws: number }
}

export type RouteCatalogEntry = {
  key: string
  ipc: string | null
  domain: string
  target: 'cxx' | 'python' | 'ws'
  phase: number
  status: 'done' | 'partial' | 'planned'
  engine_command?: string | null
  http?: { method: string; path: string; note?: string } | null
  ws?: string | null
}

export type RouteCatalog = {
  version: number
  summary: RouteCatalogSummary
  routes: RouteCatalogEntry[]
}

export function nativeRuntimeBaseUrl(
  port: number = DEFAULT_NATIVE_RUNTIME_PORT,
  host: string = DEFAULT_NATIVE_RUNTIME_HOST
): string {
  return `http://${host}:${port}`
}
