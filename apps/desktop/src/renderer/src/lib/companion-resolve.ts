import { DEFAULT_OMEGA_SYSTEM_PROMPT } from '../../../shared/assistant-prompt'
import { normalizeModelId } from './model-id'
import { getActiveChat, type ActiveChatState } from './active-chat-bridge'
import { engineClient } from './engine'

function normalizeActiveChat(raw: unknown): ActiveChatState | null {
  if (raw == null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const sessionId =
    typeof o.sessionId === 'string'
      ? o.sessionId
      : o.sessionId === null || o.sessionId === undefined
        ? null
        : null
  return {
    sessionId,
    modelId: typeof o.modelId === 'string' ? o.modelId : '',
    systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt : ''
  }
}

async function readActiveChatFromMain(): Promise<ActiveChatState> {
  const local = getActiveChat()
  try {
    const remote = normalizeActiveChat(await engineClient.companion.getActiveChat())
    if (remote) {
      return {
        sessionId: remote.sessionId ?? local.sessionId,
        modelId: remote.modelId?.trim() || local.modelId,
        systemPrompt: remote.systemPrompt?.trim() || local.systemPrompt
      }
    }
  } catch {
    /* runtime not ready — use in-window state from ChatPage */
  }
  return local
}

/** Detached desktop overlay — separate HTML entry (avatar-monitor.html). */
export function isDetachedAvatarMonitor(): boolean {
  if (typeof window === 'undefined') return false
  if (/avatar-monitor/i.test(window.location.pathname)) return true
  return document.title === 'Omega Monitor'
}

export async function resolveCompanionModel(): Promise<{
  modelId: string
  systemPrompt: string
  voiceEnabled: boolean
}> {
  const active = await readActiveChatFromMain()
  const cfg = (await engineClient.config.get().catch(() => null)) ?? {}
  const runtime = await engineClient.runtime.status().catch(() => null)
  const models = await engineClient.models.list().catch(() => [])

  let modelId =
    active.modelId?.trim() ||
    runtime?.activeModel?.trim() ||
    cfg.omegaTools?.assistantModelId?.trim() ||
    cfg.defaultModel?.trim() ||
    ''

  if (!modelId && models.length > 0) {
    const first = models.find((m) => m.path || m.remote || m.id.startsWith('ollama:'))
    modelId = first?.id?.trim() ?? models[0]?.id?.trim() ?? ''
  }

  const systemPrompt =
    active.systemPrompt?.trim() || cfg.systemPrompt?.trim() || DEFAULT_OMEGA_SYSTEM_PROMPT
  const voiceEnabled = Boolean(cfg.omegaTools?.voiceEnabled)
  return { modelId: normalizeModelId(modelId), systemPrompt, voiceEnabled }
}

export async function resolveActiveChatSessionId(): Promise<string | null> {
  const { sessionId } = await readActiveChatFromMain()
  if (sessionId) {
    try {
      const list = (await engineClient.sessions.list()) as Array<{ id: string }>
      if (list.some((s) => s.id === sessionId)) return sessionId
    } catch {
      /* ignore */
    }
  }
  try {
    const draftRaw = sessionStorage.getItem('omega.chat.draft')
    if (draftRaw) {
      const draft = JSON.parse(draftRaw) as { sessionId?: string | null }
      if (draft.sessionId) return draft.sessionId
    }
  } catch {
    /* ignore */
  }
  try {
    const list = (await engineClient.sessions.list()) as Array<{ id: string; updatedAt: number }>
    if (!list.length) return null
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    return sorted[0]?.id ?? null
  } catch {
    return null
  }
}
