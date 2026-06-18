import type { ScreenSnipCaptureResult } from '../../../shared/screen-snip-types'
import { dispatchChatAttachment } from './chat-attach-bridge'
import { resolveActiveChatSessionId, resolveCompanionModel } from './companion-chat'
import { engineClient } from './engine'

export async function stageSnipToCompanion(
  capture: ScreenSnipCaptureResult
): Promise<void> {
  await stageSnipToMainChat(capture)
}

export async function stageSnipToMainChat(capture: ScreenSnipCaptureResult): Promise<void> {
  let sessionId = await resolveActiveChatSessionId()
  if (!sessionId) {
    const { modelId, systemPrompt } = await resolveCompanionModel()
    if (!modelId) throw new Error('No model loaded.')
    const row = (await engineClient.sessions.create('New chat', modelId, systemPrompt)) as { id: string }
    sessionId = row.id
  }
  const mediaRef = await engineClient.chat.stageAttachment(sessionId, capture.tempPath)
  dispatchChatAttachment({
    target: 'main',
    mediaRef,
    autoSend: true,
    prompt: 'What do you see in this screenshot?'
  })
  window.dispatchEvent(new CustomEvent('omega:focus-chat'))
}
