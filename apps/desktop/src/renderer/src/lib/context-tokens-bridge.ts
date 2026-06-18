/** Live session context token estimate — shared between Chat and the companion. */

export type ContextTokensState = {
  sessionId: string | null
  tokenEstimate: number
  maxContext: number
  messageCount: number
}

const EVENT = 'omega:context-tokens'

let last: ContextTokensState = {
  sessionId: null,
  tokenEstimate: 0,
  maxContext: 0,
  messageCount: 0
}

export function publishContextTokens(state: ContextTokensState): void {
  last = state
  window.dispatchEvent(new CustomEvent<ContextTokensState>(EVENT, { detail: state }))
}

export function getContextTokens(): ContextTokensState {
  return { ...last }
}

export function onContextTokens(handler: (state: ContextTokensState) => void): () => void {
  const fn = (e: Event): void => {
    const d = (e as CustomEvent<ContextTokensState>).detail
    if (d) handler(d)
  }
  window.addEventListener(EVENT, fn)
  handler(getContextTokens())
  return () => window.removeEventListener(EVENT, fn)
}

export function formatContextTokensLabel(state: ContextTokensState): string {
  if (!state.sessionId || state.maxContext <= 0) return ''
  return `${state.tokenEstimate.toLocaleString()} / ${state.maxContext.toLocaleString()}`
}
