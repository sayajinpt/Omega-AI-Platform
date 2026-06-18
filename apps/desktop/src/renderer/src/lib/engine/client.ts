import type {
  EngineCommandPayload,
  EngineCommandResponse,
  EngineCommandType
} from '@omega/sdk'
import type { OmegaApi } from '../omega'

/**
 * Typed engine command dispatch (Phase 10).
 * Prefer domain helpers on `engineClient`; use `command` for headless/tests.
 */
export async function engineCommand<T extends EngineCommandType>(
  type: T,
  payload: EngineCommandPayload[T]
): Promise<EngineCommandResponse<T>> {
  return window.omega.engine.command(type, payload)
}

/** Full preload API + typed `command` — sole renderer entry to main process (Phase 10). */
export type EngineClient = OmegaApi & {
  command: typeof engineCommand
}

function createEngineClient(): EngineClient {
  return new Proxy({} as EngineClient, {
    get(_target, prop: string | symbol) {
      if (prop === 'command') return engineCommand
      if (typeof prop !== 'string') return undefined
      return (window.omega as unknown as Record<string, unknown>)[prop]
    }
  })
}

export const engineClient = createEngineClient()

export async function refreshRuntimeSnapshot(): Promise<{
  activeModel: string
  loadedModels: string[]
  backend?: string
  engineError?: string
}> {
  const st = await engineClient.runtime.status()
  let loadedModels: string[] = []
  try {
    loadedModels = await engineClient.runtime.loadedModels()
  } catch {
    const stems = (st as { runtimeLoadedStems?: string[] }).runtimeLoadedStems
    loadedModels = Array.isArray(stems) ? stems : []
  }
  const engineError =
    typeof (st as { engine_error?: string }).engine_error === 'string'
      ? (st as { engine_error: string }).engine_error
      : undefined
  const activeModel = engineError ? '' : (st.activeModel ?? '')
  const backend = st.inference ?? (await engineClient.inference.backend().catch(() => undefined))
  return {
    activeModel,
    loadedModels: engineError ? [] : loadedModels,
    backend,
    engineError
  }
}
