import { engineClient } from './engine'
/** Companion quick-chat transcript updates (user line + streaming assistant reply). */

export type CompanionReplyPayload = {
  userText?: string
  assistantText: string
  done: boolean
  error?: string
}

/** In-window companion listens here immediately — do not rely on IPC round-trip alone. */
export const COMPANION_REPLY_LOCAL_EVENT = 'omega:companion-reply-local'

let activeCompanionStreamId: string | null = null

export function markCompanionStream(streamId: string): void {
  activeCompanionStreamId = streamId
}

export function clearCompanionStream(streamId?: string): void {
  if (streamId == null || activeCompanionStreamId === streamId) {
    activeCompanionStreamId = null
  }
}

export function isCompanionStream(streamId: string): boolean {
  return activeCompanionStreamId === streamId
}

/** Push transcript update to companion UI (local + detached monitor via runtime). */
export function publishCompanionReply(payload: CompanionReplyPayload): void {
  window.dispatchEvent(new CustomEvent(COMPANION_REPLY_LOCAL_EVENT, { detail: payload }))
  try {
    engineClient.companion.broadcastReply(payload)
  } catch {
    /* bridge not ready */
  }
}

export function onCompanionReply(handler: (payload: CompanionReplyPayload) => void): () => void {
  const onLocal = (e: Event): void => {
    const d = (e as CustomEvent<CompanionReplyPayload>).detail
    if (d) handler(d)
  }
  window.addEventListener(COMPANION_REPLY_LOCAL_EVENT, onLocal)
  const offRemote = engineClient.companion.onReplyDeliver(handler)
  return () => {
    window.removeEventListener(COMPANION_REPLY_LOCAL_EVENT, onLocal)
    offRemote()
  }
}
