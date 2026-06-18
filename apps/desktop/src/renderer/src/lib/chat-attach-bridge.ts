import type { MediaRef } from '@omega/sdk'

export type ChatAttachTarget = 'main' | 'companion'

export type ChatAttachDetail = {
  target: ChatAttachTarget
  mediaRef: MediaRef
  /** Send immediately with a default prompt when true. */
  autoSend?: boolean
  prompt?: string
}

const EVENT = 'omega:chat-attach'

export function dispatchChatAttachment(detail: ChatAttachDetail): void {
  window.dispatchEvent(new CustomEvent<ChatAttachDetail>(EVENT, { detail }))
}

export function onChatAttachment(handler: (detail: ChatAttachDetail) => void): () => void {
  const fn = (e: Event): void => {
    const ce = e as CustomEvent<ChatAttachDetail>
    if (ce.detail?.mediaRef) handler(ce.detail)
  }
  window.addEventListener(EVENT, fn)
  return () => window.removeEventListener(EVENT, fn)
}
