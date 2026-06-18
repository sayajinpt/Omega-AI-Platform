import type { MediaRef } from '@omega/sdk'
import { normalizeModelId } from './model-id'
import { engineClient } from './engine'
import {
  COMPANION_TO_CHAT_EVENT,
  normalizeChatCompanionSendDetail
} from './chat-companion-send'
import { isDetachedAvatarMonitor } from './companion-resolve'

export {
  isDetachedAvatarMonitor,
  resolveActiveChatSessionId,
  resolveCompanionModel
} from './companion-resolve'

export { COMPANION_TO_CHAT_EVENT } from './chat-companion-send'
export type { ChatCompanionSendDetail as CompanionToChatDetail } from './chat-companion-send'

/** Companion is a second UI for the same chat send — routes to ChatPage.send(fromCompanion). */
export async function sendCompanionMessage(opts: {
  userText: string
  attachments?: MediaRef[]
}): Promise<{ ok: boolean; error?: string }> {
  const text = opts.userText.trim()
  if (!text && !opts.attachments?.length) {
    return { ok: false, error: 'Empty message' }
  }

  const detail: CompanionToChatDetail = { text, attachments: opts.attachments }

  if (!isDetachedAvatarMonitor()) {
    window.dispatchEvent(new CustomEvent('omega:focus-chat'))
    window.dispatchEvent(new CustomEvent(COMPANION_TO_CHAT_EVENT, { detail }))
    return { ok: true }
  }

  try {
    const res = (await engineClient.companion.sendToMainChat(detail)) as
      | { ok: true }
      | { ok: false; error?: string }
    if (res?.ok === false) {
      return { ok: false, error: res.error ?? 'Could not send to chat' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Detached monitor → main window: same event ChatPage already listens for. */
export function deliverCompanionToChat(raw: unknown): boolean {
  const detail = normalizeChatCompanionSendDetail(raw)
  if (!detail) return false
  window.dispatchEvent(new CustomEvent(COMPANION_TO_CHAT_EVENT, { detail }))
  return true
}

export function cancelCompanionMessage(): void {
  window.dispatchEvent(new CustomEvent('omega:cancel'))
}

export { normalizeModelId }
