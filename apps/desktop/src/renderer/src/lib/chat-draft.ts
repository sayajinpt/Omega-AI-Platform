const DRAFT_KEY = 'omega.chat.draft'

export type ChatDraft = {
  input: string
  sessionId: string | null
  modelId: string
  agentMode: boolean
}

export function loadChatDraft(): Partial<ChatDraft> {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Partial<ChatDraft>
  } catch {
    return {}
  }
}

export function saveChatDraft(draft: ChatDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* ignore */
  }
}

export function clearChatDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}
