import {
  DEFAULT_NATIVE_RUNTIME_PORT,
  httpInvokeIpc,
  isIpcHttpChannel,
  nativeRuntimeBaseUrl,
  RUNTIME_HTTP_ROUTES,
  type NativeRuntimeInfo,
  type RouteCatalog
} from '@omega/sdk'
import type { OmegaConfig } from '@omega/sdk'

export type NativeRuntimeProbe = {
  reachable: boolean
  baseUrl: string
  info?: NativeRuntimeInfo
  catalog?: RouteCatalog
  error?: string
}

export type RuntimeTransportMode = 'http'

export type RuntimeClientOptions = {
  port?: number
  mode?: RuntimeTransportMode
  /** When true, probe HTTP before each call (default: cache probe result). */
  alwaysProbe?: boolean
}

let cachedProbe: NativeRuntimeProbe | null = null
let probeAt = 0
const PROBE_TTL_MS = 5000

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}

export async function probeNativeRuntime(
  port: number = DEFAULT_NATIVE_RUNTIME_PORT,
  opts?: { includeCatalog?: boolean }
): Promise<NativeRuntimeProbe> {
  const baseUrl = nativeRuntimeBaseUrl(port)
  try {
    const healthRes = await fetch(`${baseUrl}${RUNTIME_HTTP_ROUTES.health}`, {
      signal: AbortSignal.timeout(2500)
    })
    if (!healthRes.ok) {
      return { reachable: false, baseUrl, error: `health ${healthRes.status}` }
    }
    const info = await fetchJson<NativeRuntimeInfo>(`${baseUrl}${RUNTIME_HTTP_ROUTES.runtimeInfo}`, {
      signal: AbortSignal.timeout(2500)
    })
    let catalog: RouteCatalog | undefined
    if (opts?.includeCatalog) {
      catalog = await fetchJson<RouteCatalog>(`${baseUrl}${RUNTIME_HTTP_ROUTES.runtimeRoutes}`, {
        signal: AbortSignal.timeout(5000)
      })
    }
    return { reachable: true, baseUrl, info, catalog }
  } catch (e) {
    return {
      reachable: false,
      baseUrl,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

async function ensureProbe(options: RuntimeClientOptions): Promise<NativeRuntimeProbe> {
  const now = Date.now()
  if (!options.alwaysProbe && cachedProbe && now - probeAt < PROBE_TTL_MS) {
    return cachedProbe
  }
  cachedProbe = await probeNativeRuntime(options.port)
  probeAt = now
  return cachedProbe
}

/** Native HTTP client for omega-runtime (127.0.0.1:9877). */
export class RuntimeClient {
  private options: Required<RuntimeClientOptions>

  constructor(options: RuntimeClientOptions = {}) {
    this.options = {
      port: options.port ?? DEFAULT_NATIVE_RUNTIME_PORT,
      mode: 'http',
      alwaysProbe: options.alwaysProbe ?? false
    }
  }

  async probe(includeCatalog = false): Promise<NativeRuntimeProbe> {
    const probe = await probeNativeRuntime(this.options.port, { includeCatalog })
    cachedProbe = probe
    probeAt = Date.now()
    return probe
  }

  /** Invoke by IPC channel name via native HTTP route catalog. */
  async invoke<T = unknown>(ipc: string, payload?: unknown): Promise<T> {
    await ensureProbe(this.options)
    if (!isIpcHttpChannel(ipc)) {
      throw new Error(`No HTTP mapping for ${ipc} — see GET /v1/runtime/routes`)
    }
    const args = payload === undefined ? [] : [payload]
    return (await httpInvokeIpc(ipc, args, { port: this.options.port })) as T
  }

  async invokeHttp<T = unknown>(ipc: string, payload?: unknown): Promise<T> {
    return this.invoke<T>(ipc, payload)
  }

  async getConfig(): Promise<OmegaConfig> {
    return this.invoke<OmegaConfig>('omega:config:get')
  }

  async patchConfig(patch: Partial<OmegaConfig>): Promise<OmegaConfig> {
    return this.invoke<OmegaConfig>('omega:config:set', patch)
  }

  async runtimeStatus(): Promise<Record<string, unknown>> {
    return this.invoke('omega:runtime:status')
  }

  async listModels(): Promise<unknown> {
    return this.invoke('omega:models:list')
  }

  async routeCatalog(): Promise<RouteCatalog> {
    const probe = await ensureProbe(this.options)
    if (!probe.reachable) throw new Error('omega-runtime is not reachable')
    return fetchJson<RouteCatalog>(`${probe.baseUrl}${RUNTIME_HTTP_ROUTES.runtimeRoutes}`)
  }

  /** Long-poll global push events (omega:stream:token, omega:agent:step, …). */
  async pollEvents(
    cursor = 0,
    timeoutMs = 15000
  ): Promise<{ events: Array<{ channel: string; payload: unknown; ts: number }>; cursor: number }> {
    const probe = await ensureProbe(this.options)
    if (!probe.reachable) throw new Error('omega-runtime is not reachable')
    const url = `${probe.baseUrl}${RUNTIME_HTTP_ROUTES.eventsPoll}?cursor=${cursor}&timeout=${timeoutMs}`
    return fetchJson(url)
  }

  /** Subscribe to native runtime event stream. Returns unsubscribe. */
  subscribeEventStream(
    onEvent: (channel: string, payload: unknown) => void,
    opts?: { cursor?: number; signal?: AbortSignal }
  ): () => void {
    const controller = new AbortController()
    const signal = opts?.signal ?? controller.signal
    let cursor = opts?.cursor ?? 0
    let active = true

    const loop = async (): Promise<void> => {
      while (active && !signal.aborted) {
        try {
          const probe = await ensureProbe(this.options)
          if (!probe.reachable) {
            await new Promise((r) => setTimeout(r, 2000))
            continue
          }
          const res = await fetch(
            `${probe.baseUrl}${RUNTIME_HTTP_ROUTES.eventsPoll}?cursor=${cursor}&timeout=15000`,
            { signal }
          )
          if (!res.ok) continue
          const body = (await res.json()) as {
            events: Array<{ channel: string; payload: unknown }>
            cursor: number
          }
          cursor = body.cursor
          for (const e of body.events) onEvent(e.channel, e.payload)
        } catch {
          if (signal.aborted) break
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    void loop()

    return () => {
      active = false
      controller.abort()
    }
  }
}

export const runtimeClient = new RuntimeClient()
