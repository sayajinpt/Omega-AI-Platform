import {
  DEFAULT_NATIVE_RUNTIME_PORT,
  httpInvokeIpc,
  IPC_EVENT_CHANNELS,
  nativeRuntimeBaseUrl,
  RUNTIME_HTTP_ROUTES
} from '@omega/sdk'

/** Shell-only push channels (application menu, context menu) when a host exposes IPC. */
const SHELL_EVENT_CHANNELS = new Set(['omega:shortcut', 'omega:context:find', 'omega:context:gotoLine'])

type Listener = (...args: any[]) => void

let shellEventDispatch: ((channel: string, payload: unknown) => void) | null = null

/** WebView2 shell posts UI events (companion, avatar, media) via PostWebMessage. */
export function dispatchShellEvent(channel: string, payload: unknown): void {
  shellEventDispatch?.(channel, payload)
}

export type OmegaRuntimeBridge = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: Listener): void
  removeListener(channel: string, listener: Listener): void
}

/** @deprecated Use OmegaRuntimeBridge — kept for search/rename compatibility. */
export type ElectronIpcLike = OmegaRuntimeBridge

export type OmegaHttpBridgeOptions = {
  port?: number
  shellIpc?: OmegaRuntimeBridge
}

export function createOmegaHttpBridge(options: OmegaHttpBridgeOptions = {}): OmegaRuntimeBridge {
  const port = options.port ?? DEFAULT_NATIVE_RUNTIME_PORT
  const baseUrl = () => nativeRuntimeBaseUrl(port)
  const shell = options.shellIpc

  const listeners = new Map<string, Set<Listener>>()
  let eventCursor = 0
  let pollActive = false
  let pollAbort: AbortController | null = null
  let approvalPollActive = false
  let approvalPollAbort: AbortController | null = null
  const knownPendingToolIds = new Set<string>()

  function addListener(channel: string, listener: Listener): void {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    if (!SHELL_EVENT_CHANNELS.has(channel)) startEventPoll()
    syncApprovalPendingPoll()
  }

  function syncApprovalPendingPoll(): void {
    const needs =
      (listeners.get('omega:tool:approve:req')?.size ?? 0) > 0 ||
      (listeners.get('omega:capability:permission:req')?.size ?? 0) > 0
    if (needs) startApprovalPendingPoll()
    else stopApprovalPendingPoll()
  }

  function removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener)
    syncApprovalPendingPoll()
  }

  function dispatch(channel: string, payload: unknown): void {
    for (const fn of listeners.get(channel) ?? []) {
      fn(null, payload)
    }
  }

  shellEventDispatch = dispatch

  function startEventPoll(): void {
    if (pollActive) return
    pollActive = true
    pollAbort = new AbortController()
    const signal = pollAbort.signal

    const loop = async (): Promise<void> => {
      while (!signal.aborted) {
        try {
          const res = await fetch(
            `${baseUrl()}${RUNTIME_HTTP_ROUTES.eventsPoll}?cursor=${eventCursor}&timeout=15000`,
            { signal }
          )
          if (!res.ok) {
            await sleep(1500)
            continue
          }
          const body = (await res.json()) as {
            events: Array<{ channel: string; payload: unknown }>
            cursor: number
          }
          eventCursor = body.cursor
          for (const e of body.events) dispatch(e.channel, e.payload)
        } catch {
          if (signal.aborted) break
          await sleep(1000)
        }
      }
      pollActive = false
    }
    void loop()
  }

  function stopApprovalPendingPoll(): void {
    approvalPollAbort?.abort()
    approvalPollAbort = null
    approvalPollActive = false
  }

  function startApprovalPendingPoll(): void {
    if (approvalPollActive) return
    approvalPollActive = true
    approvalPollAbort = new AbortController()
    const signal = approvalPollAbort.signal

    const pollPending = async (): Promise<void> => {
      while (!signal.aborted) {
        try {
          const base = baseUrl()
          const [toolsRes, capsRes] = await Promise.all([
            fetch(`${base}/v1/tool/approve/pending`, { signal }),
            fetch(`${base}/v1/capability/permission/pending`, { signal })
          ])
          if (toolsRes.ok) {
            const pending = (await toolsRes.json()) as unknown
            if (Array.isArray(pending)) {
              const liveIds = new Set<string>()
              for (const payload of pending) {
                const id =
                  payload !== null && typeof payload === 'object' && 'id' in payload
                    ? String((payload as { id: unknown }).id)
                    : ''
                if (id) liveIds.add(id)
                if (id && !knownPendingToolIds.has(id)) {
                  knownPendingToolIds.add(id)
                  dispatch('omega:tool:approve:req', payload)
                }
              }
              for (const id of [...knownPendingToolIds]) {
                if (!liveIds.has(id)) {
                  knownPendingToolIds.delete(id)
                  dispatch('omega:tool:approve:expired', { id })
                }
              }
            }
          }
          if (capsRes.ok) {
            const pending = (await capsRes.json()) as unknown
            if (Array.isArray(pending)) {
              for (const payload of pending) {
                dispatch('omega:capability:permission:req', payload)
              }
            }
          }
        } catch {
          if (signal.aborted) break
        }
        await sleep(1500)
      }
      approvalPollActive = false
    }
    void pollPending()
  }

  return {
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      return (await httpInvokeIpc(channel, args, { port })) as T
    },

    send(channel: string, ...args: unknown[]): void {
      void httpInvokeIpc(channel, args, { port }).catch((e) => {
        console.error('[omega-http] send failed', channel, e)
      })
    },

    on(channel: string, listener: Listener): void {
      if (SHELL_EVENT_CHANNELS.has(channel) && shell) {
        shell.on(channel, listener)
        return
      }
      addListener(channel, listener)
    },

    removeListener(channel: string, listener: Listener): void {
      if (SHELL_EVENT_CHANNELS.has(channel) && shell) {
        shell.removeListener(channel, listener)
        return
      }
      removeListener(channel, listener)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** All push event channels the bridge listens for via /v1/events/poll. */
export const OMEGA_HTTP_EVENT_CHANNELS = IPC_EVENT_CHANNELS
