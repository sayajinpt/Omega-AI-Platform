import {
  DEFAULT_NATIVE_RUNTIME_HOST,
  DEFAULT_NATIVE_RUNTIME_PORT,
  nativeRuntimeBaseUrl
} from './runtime-api'
import {
  IPC_HTTP_MAP,
  type IpcHttpChannel,
  isIpcHttpChannel
} from './ipc-http-map.generated'

export type HttpInvokeOptions = {
  port?: number
  host?: string
  timeoutMs?: number
}

const GET_QUERY_KEYS: Record<string, string[]> = {
  'omega:model-config:get': ['modelId'],
  'omega:model-config:reset': ['modelId'],
  'omega:sessions:messages': ['sessionId'],
  'omega:sessions:search': ['query'],
  'omega:memory:search': ['q'],
  'omega:memory:graph': ['runId'],
  'omega:memory:projectContext': ['sessionId'],
  'omega:workflows:get': ['id'],
  'omega:skills:get': ['id'],
  'omega:input-pipelines:get': ['id'],
  'omega:finetune:get': ['id'],
  'omega:context:buffer': ['sessionId', 'modelId'],
  'omega:usage:summary': ['sessionId'],
  'omega:gpu:list': ['force'],
  'omega:hf:card': ['repo'],
  'omega:models:repo-files': ['repo'],
  'omega:models:check-hf-access': ['repo'],
  'omega:models:open-hf-repo': ['repo'],
  'omega:models:footprint': ['model'],
  'omega:models:benchmark': ['model'],
  'omega:model:inspect': ['modelId'],
  'omega:content-studio:runStatus': ['jobId'],
  'omega:content-studio:generationCapabilities': ['modality', 'repoId'],
  'omega:chat:abort': ['streamId'],
  'omega:routerModels:remove': ['role'],
  'omega:models:download:cancel': ['repo', 'filename'],
  'omega:finetune:abort': ['jobId']
}

function baseUrl(opts: HttpInvokeOptions): string {
  return nativeRuntimeBaseUrl(opts.port ?? DEFAULT_NATIVE_RUNTIME_PORT, opts.host ?? DEFAULT_NATIVE_RUNTIME_HOST)
}

function buildGetUrl(path: string, channel: string, args: unknown[]): string {
  if (args.length === 0) return path
  const url = new URL(path, 'http://local')
  const keys = GET_QUERY_KEYS[channel]
  if (keys) {
    args.forEach((a, i) => {
      if (keys[i] !== undefined && a !== undefined && a !== null) {
        url.searchParams.set(keys[i], String(a))
      }
    })
    return `${url.pathname}${url.search}`
  }
  if (args.length === 1 && typeof args[0] === 'string') {
    const key = channel.includes('repo')
      ? 'repo'
      : channel.includes('session')
        ? 'sessionId'
        : channel.includes('model')
          ? 'modelId'
          : channel.includes('search')
            ? 'query'
            : 'id'
    url.searchParams.set(key, args[0])
    return `${url.pathname}${url.search}`
  }
  if (args.length === 1 && typeof args[0] === 'boolean') {
    url.searchParams.set('force', String(args[0]))
    return `${url.pathname}${url.search}`
  }
  return path
}

const MODEL_ID_BODY_CHANNELS = new Set([
  'omega:models:load',
  'omega:models:unload',
  'omega:model-config:get',
  'omega:model-config:set',
  'omega:model-config:reset',
  'omega:model:inspect',
  'omega:model:estimate',
  'omega:models:footprint',
  'omega:models:benchmark'
])

function buildRequestBody(channel: string, args: unknown[]): string | undefined {
  if (channel === 'omega:sessions:create') {
    return JSON.stringify({
      title: args[0] ?? 'New chat',
      modelId: args[1] ?? '',
      systemPrompt: args[2] ?? ''
    })
  }
  if (channel === 'omega:sessions:delete') {
    return JSON.stringify({ id: args[0] ?? '' })
  }
  if (channel === 'omega:input-pipelines:delete') {
    return JSON.stringify({ id: args[0] ?? '' })
  }
  if (channel === 'omega:workflows:delete') {
    return JSON.stringify({ id: args[0] ?? '' })
  }
  if (channel === 'omega:memory:delete' || channel === 'omega:skills:delete' ||
      channel === 'omega:profiles:delete' || channel === 'omega:cron:delete' ||
      channel === 'omega:kanban:delete' || channel === 'omega:mcp:delete' ||
      channel === 'omega:providers:delete' || channel === 'omega:gateway:delete' ||
      channel === 'omega:finetune:delete' || channel === 'omega:plugins:uninstall') {
    return JSON.stringify({ id: args[0] ?? '' })
  }
  if (channel === 'omega:chat:abort') {
    return JSON.stringify({ streamId: args[0] ?? '' })
  }
  if (channel === 'omega:routerModels:remove') {
    return JSON.stringify({ role: args[0] ?? 'embedding' })
  }
  if (channel === 'omega:models:download:cancel') {
    return JSON.stringify({ repo: args[0] ?? '', filename: args[1] ?? '' })
  }
  if (channel === 'omega:finetune:abort') {
    return JSON.stringify({ jobId: args[0] ?? '' })
  }
  if (channel === 'omega:mcp:stop' || channel === 'omega:gateway:stop') {
    return JSON.stringify({ id: args[0] ?? '' })
  }
  if (channel === 'omega:engines:sidecar:install') {
    const raw = args[0]
    const components = Array.isArray(raw)
      ? raw.filter((c): c is string => typeof c === 'string')
      : []
    return JSON.stringify({ components })
  }
  if (channel === 'omega:sessions:updateModel') {
    return JSON.stringify({ id: args[0] ?? '', modelId: args[1] ?? '' })
  }
  if (channel === 'omega:config:set') {
    return JSON.stringify({ patch: args[0] ?? {} })
  }
  if (channel === 'omega:engine:command') {
    const req = args[0] ?? {}
    return JSON.stringify(req)
  }
  if (channel === 'omega:content-studio:setupEnvironment') {
    const opts =
      args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])
        ? (args[0] as { profile?: string })
        : {}
    const profile = opts.profile === 'content-media' ? 'content-media' : 'content'
    return JSON.stringify({ profile, async: true })
  }
  if (channel === 'omega:python:setup') {
    const opts =
      args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])
        ? (args[0] as { profile?: string })
        : {}
    return JSON.stringify({ profile: opts.profile ?? 'base', async: true })
  }
  if (channel === 'omega:content-studio:runStatus') {
    return JSON.stringify({ jobId: String(args[0] ?? '') })
  }
  if (channel === 'omega:browser:show') {
    return JSON.stringify({
      bounds: args[0] ?? {},
      mode: typeof args[1] === 'string' ? args[1] : 'full'
    })
  }
  if (channel === 'omega:browser:setBounds') {
    return JSON.stringify({ bounds: args[0] ?? {} })
  }
  if (channel === 'omega:browser:navigate') {
    return JSON.stringify({ url: String(args[0] ?? '') })
  }
  if (channel === 'omega:tool:approve:resolve') {
    return JSON.stringify({ id: String(args[0] ?? ''), approved: Boolean(args[1]) })
  }
  if (channel === 'omega:capability:permission:resolve') {
    return JSON.stringify({
      id: String(args[0] ?? ''),
      approved: Boolean(args[1]),
      remember: Boolean(args[2])
    })
  }
  if (channel === 'omega:avatar-monitor:set-enabled') {
    const enabled = Boolean(args[0])
    const state = args[1] !== null && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] : undefined
    return JSON.stringify(state ? { enabled, state } : { enabled })
  }
  if (channel === 'omega:avatar-monitor:signals' && args.length > 0) {
    const signals = args[0]
    if (signals !== null && typeof signals === 'object' && !Array.isArray(signals)) {
      return JSON.stringify(signals)
    }
  }
  if (args.length === 0) return undefined
  if (args.length === 1 && typeof args[0] === 'string' && MODEL_ID_BODY_CHANNELS.has(channel)) {
    return JSON.stringify({ modelId: args[0] })
  }
  if (args.length === 1) {
    const only = args[0]
    if (only !== null && typeof only === 'object' && !Array.isArray(only)) {
      return JSON.stringify(only)
    }
  }
  return JSON.stringify(args)
}

/** Engine /v1/models returns `{ models: [...] }`; UI IPC expects a bare array. */
const LIST_ARRAY_KEYS = [
  'models',
  'entries',
  'items',
  'sessions',
  'tools',
  'plugins',
  'results',
  'jobs',
  'skills',
  'workflows',
  'providers',
  'servers',
  'posts',
  'accounts',
  'platforms',
  'projects',
  'series',
  'schedules',
  'sources',
  'hits',
  'files',
  'devices',
  'gpus',
  'catalog',
  'presets',
  'pipelines',
  'tasks',
  'agents',
  'events',
  'rows'
] as const

/** Content Studio GET list routes — must always be arrays for React `.map` / `.length`. */
const CONTENT_STUDIO_LIST_CHANNELS = new Set<string>([
  'omega:content-studio:projects',
  'omega:content-studio:schedules',
  'omega:content-studio:seriesList',
  'omega:content-studio:socialPlatforms',
  'omega:content-studio:socialAccounts',
  'omega:content-studio:socialPosts'
])

function unwrapListArray(data: unknown): unknown {
  if (Array.isArray(data)) return data
  if (data === null || typeof data !== 'object') return data
  const obj = data as Record<string, unknown>
  for (const key of LIST_ARRAY_KEYS) {
    if (Array.isArray(obj[key])) return obj[key]
  }
  return data
}

/** IPC list endpoints must always yield arrays for React `.map` / `.reduce`. */
function coerceArray(data: unknown): unknown[] {
  const unwrapped = unwrapListArray(data)
  return Array.isArray(unwrapped) ? unwrapped : []
}

/** Fine-tune dataset list routes — must always be arrays for React `.length` / `.map`. */
const FINETUNE_LIST_CHANNELS = new Set<string>([
  'omega:finetune:listDatasets',
  'omega:finetune:listPresets'
])

function unwrapResponse(channel: string, data: unknown, request?: unknown): unknown {
  if (CONTENT_STUDIO_LIST_CHANNELS.has(channel) || FINETUNE_LIST_CHANNELS.has(channel)) {
    return coerceArray(data)
  }
  if (data === null || typeof data !== 'object') return data
  const obj = data as Record<string, unknown>

  if (channel === 'omega:chat:pick-attachments') {
    if (Array.isArray(obj.paths)) return obj.paths
    return []
  }
  if (channel === 'omega:finetune:pickSources') {
    if (Array.isArray(data)) return data
    if (Array.isArray(obj.paths)) return obj.paths
    return []
  }
  if (channel === 'omega:config:get' || channel === 'omega:config:set') {
    return obj.config ?? data
  }
  if (channel === 'omega:engine:command') {
    const req = (request ?? {}) as { id?: string; type?: string }
    return {
      id: req.id ?? '',
      type: req.type ?? '',
      success: obj.success === true,
      data: obj.data,
      error: typeof obj.error === 'string' ? obj.error : undefined
    }
  }
  if (
    channel === 'omega:gpu:list' ||
    channel === 'omega:memory:graph' ||
    channel === 'omega:engines:ollama:list'
  ) {
    return coerceArray(data)
  }
  if (channel === 'omega:content-studio:generationCatalog') {
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }
  if (channel === 'omega:content-studio:generationCapabilities') {
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }
  if (
    channel === 'omega:content-studio:credentialsGet' ||
    channel === 'omega:content-studio:generationGet'
  ) {
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }
  if (channel === 'omega:debug:history') {
    return coerceArray(data)
  }
  if (channel === 'omega:runtime:loaded' || channel === 'omega:models:list') {
    return coerceArray(data)
  }
  if (channel.endsWith(':list') || channel.endsWith(':List')) {
    // Per-model config map is an object, not an array.
    if (channel === 'omega:model-config:list') return data
    return coerceArray(data)
  }
  return data
}

const LONG_DOWNLOAD_CHANNELS = new Set<string>([
  'omega:content-studio:generationDownload',
  'omega:models:download',
  'omega:models:download-required',
  'omega:models:download-adapter'
])

/** Large HF downloads can run for hours on slow links. */
const LONG_DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000

export async function httpInvokeIpc(
  channel: string,
  args: unknown[] = [],
  opts: HttpInvokeOptions = {}
): Promise<unknown> {
  if (!isIpcHttpChannel(channel)) {
    throw new Error(`No HTTP route for ${channel} — regenerate ipc-http-map or check preload invoke list`)
  }
  const route = IPC_HTTP_MAP[channel as IpcHttpChannel]
  const timeoutMs =
    opts.timeoutMs ??
    (channel === 'omega:engine:command'
      ? 600_000
      : LONG_DOWNLOAD_CHANNELS.has(channel)
        ? LONG_DOWNLOAD_TIMEOUT_MS
      : channel.startsWith('omega:media:') || channel.startsWith('omega:browser:')
        ? 8_000
      : channel === 'omega:content-studio:setupEnvironment' || channel === 'omega:python:setup'
        ? 30_000
        : channel === 'omega:content-studio:start'
          ? 600_000
          : channel === 'omega:models:unload' || channel === 'omega:models:load'
            ? 600_000
          : channel === 'omega:chat:send'
            ? 600_000
          : 120_000)
  let path: string = route.path
  let method = route.method
  let body: string | undefined

  if (method === 'GET' && args.length > 0) {
    const withQuery = buildGetUrl(path, channel, args)
    if (withQuery === path && args.length > 0) {
      method = 'POST'
      body = buildRequestBody(channel, args)
    } else {
      path = withQuery
    }
  } else if (method === 'DELETE') {
    if (args.length > 0) {
      if (path.includes('{modelId}')) {
        path = path.replace('{modelId}', encodeURIComponent(String(args[0])))
      } else {
        path = buildGetUrl(path, channel, args)
      }
      body = buildRequestBody(channel, args)
    }
  } else if (method !== 'GET') {
    body = buildRequestBody(channel, args)
  }

  const url = `${baseUrl(opts)}${path}`
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(timeoutMs)
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = body
  }

  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let detail = text.slice(0, 480)
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string }
      if (typeof parsed.error === 'string') detail = parsed.error
      else if (typeof parsed.message === 'string') detail = parsed.message
    } catch {
      /* keep raw text */
    }
    throw new Error(`HTTP ${res.status} ${channel}${detail ? `: ${detail}` : ''}`)
  }
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  const parsed = JSON.parse(text) as unknown
  return unwrapResponse(channel, parsed, args[0])
}

export async function probeNativeRuntimeHttp(
  opts: HttpInvokeOptions = {}
): Promise<{ reachable: boolean; baseUrl: string; error?: string }> {
  const url = `${baseUrl(opts)}/healthz`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return { reachable: res.ok, baseUrl: baseUrl(opts), error: res.ok ? undefined : `health ${res.status}` }
  } catch (e) {
    return {
      reachable: false,
      baseUrl: baseUrl(opts),
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export { IPC_HTTP_MAP, isIpcHttpChannel, type IpcHttpChannel } from './ipc-http-map.generated'
