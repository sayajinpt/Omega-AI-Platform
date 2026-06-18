import type { MediaRef } from '@omega/sdk'
import { engineClient } from './engine'
import {
  deliverChatCompanionSend,
  invokeChatCompanionSend,
  normalizeChatCompanionSendDetail,
  registerChatCompanionSendHandler,
  type ChatCompanionSendDetail
} from './chat-companion-send'

export type ActiveChatState = {
  sessionId: string | null
  modelId: string
  systemPrompt: string
}

const ACTIVE_EVENT = 'omega:active-chat'
const COMPANION_SEND_EVENT = 'omega:companion-send'

let lastActive: ActiveChatState = {
  sessionId: null,
  modelId: '',
  systemPrompt: ''
}

export function publishActiveChat(state: ActiveChatState): void {
  lastActive = state
  window.dispatchEvent(new CustomEvent<ActiveChatState>(ACTIVE_EVENT, { detail: state }))
  try {
    engineClient.companion.setActiveChat(state)
  } catch {
    /* preload not ready */
  }
}

export function getActiveChat(): ActiveChatState {
  return { ...lastActive }
}

export function onActiveChat(handler: (state: ActiveChatState) => void): () => void {
  const fn = (e: Event): void => {
    const d = (e as CustomEvent<ActiveChatState>).detail
    if (d) handler(d)
  }
  window.addEventListener(ACTIVE_EVENT, fn)
  handler(getActiveChat())
  return () => window.removeEventListener(ACTIVE_EVENT, fn)
}

export type CompanionSendDetail = ChatCompanionSendDetail

export function normalizeCompanionSendDetail(raw: unknown): CompanionSendDetail | null {
  return normalizeChatCompanionSendDetail(raw)
}

export function setCompanionSendHandler(handler: ((detail: CompanionSendDetail) => void) | null): void {
  registerChatCompanionSendHandler(handler)
}

export function hasCompanionSendHandler(): boolean {
  return typeof (window as Window & { __omegaChatCompanionSendHandler?: unknown })
    .__omegaChatCompanionSendHandler === 'function'
}

export function deliverCompanionSend(raw: unknown): boolean {
  const detail = normalizeChatCompanionSendDetail(raw)
  if (!detail) return false
  window.dispatchEvent(new CustomEvent<CompanionSendDetail>(COMPANION_SEND_EVENT, { detail }))
  return invokeChatCompanionSend(detail)
}

export function dispatchCompanionSend(detail: CompanionSendDetail): boolean {
  return deliverCompanionSend(detail)
}

export function onCompanionSend(handler: (detail: CompanionSendDetail) => void): () => void {
  const fn = (e: Event): void => {
    const d = (e as CustomEvent<CompanionSendDetail>).detail
    if (d) handler(d)
  }
  window.addEventListener(COMPANION_SEND_EVENT, fn)
  return () => window.removeEventListener(COMPANION_SEND_EVENT, fn)
}

export { registerChatCompanionSendHandler, deliverChatCompanionSend, invokeChatCompanionSend }
