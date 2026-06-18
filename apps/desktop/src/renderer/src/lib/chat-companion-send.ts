import type { MediaRef } from '@omega/sdk'

/** Same-window companion → main chat (ChatPage listens on window). */
export const COMPANION_TO_CHAT_EVENT = 'omega:companion-to-chat'

export type ChatCompanionSendDetail = {
  text: string
  attachments?: MediaRef[]
}

type ChatCompanionSendHandler = (detail: ChatCompanionSendDetail) => void

/**
 * Window-global companion → chat bridge.
 * Must live on `window` so lazy-loaded Avatar3D and ChatPage chunks always share one handler.
 */
const HANDLER_KEY = '__omegaChatCompanionSendHandler'
const PENDING_KEY = '__omegaChatCompanionSendPending'

type CompanionSendWindow = Window &
  typeof globalThis & {
    [HANDLER_KEY]?: ChatCompanionSendHandler | null
    [PENDING_KEY]?: ChatCompanionSendDetail[]
  }

function companionSendWindow(): CompanionSendWindow {
  return window as CompanionSendWindow
}

function pendingCompanionSends(): ChatCompanionSendDetail[] {
  const w = companionSendWindow()
  if (!w[PENDING_KEY]) w[PENDING_KEY] = []
  return w[PENDING_KEY]!
}

export function registerChatCompanionSendHandler(handler: ChatCompanionSendHandler | null): void {
  companionSendWindow()[HANDLER_KEY] = handler
  if (!handler) return
  const queue = pendingCompanionSends()
  while (queue.length > 0) {
    const detail = queue.shift()
    if (detail) handler(detail)
  }
}

export function hasChatCompanionSendHandler(): boolean {
  return typeof companionSendWindow()[HANDLER_KEY] === 'function'
}

/** Deliver to ChatPage when registered; otherwise queue until registration. */
export function invokeChatCompanionSend(detail: ChatCompanionSendDetail): boolean {
  const handler = companionSendWindow()[HANDLER_KEY]
  if (handler) {
    handler(detail)
    return true
  }
  pendingCompanionSends().push(detail)
  return false
}

export function normalizeChatCompanionSendDetail(raw: unknown): ChatCompanionSendDetail | null {
  if (raw == null) return null
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  const attachments = Array.isArray(o.attachments) ? (o.attachments as MediaRef[]) : undefined
  if (!text && !attachments?.length) return null
  return { text, attachments }
}

export function deliverChatCompanionSend(raw: unknown): boolean {
  const detail = normalizeChatCompanionSendDetail(raw)
  if (!detail) return false
  window.dispatchEvent(new CustomEvent(COMPANION_TO_CHAT_EVENT, { detail }))
  return true
}
