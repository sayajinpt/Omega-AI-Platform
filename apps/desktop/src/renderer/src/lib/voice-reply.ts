import type { OmegaToolsSettings } from '@omega/sdk'
import { plainTextForSpeech, speakText, speechSynthesisAvailable } from './voice-assistant'

/** Mic / speech-to-text in chat composer. */
export function isVoiceInputEnabled(tools?: OmegaToolsSettings): boolean {
  return Boolean(tools?.voiceEnabled)
}

/**
 * Spoken assistant replies. When unset, follows legacy combined ``voiceEnabled`` flag.
 */
export function isVoiceOutputEnabled(tools?: OmegaToolsSettings): boolean {
  if (tools?.voiceOutputEnabled !== undefined) return Boolean(tools.voiceOutputEnabled)
  return Boolean(tools?.voiceEnabled)
}

export function resolveVoiceTtsMode(tools?: OmegaToolsSettings): 'browser' | 'content_studio' {
  const id = (tools?.voiceTtsModelId ?? 'browser').trim()
  if (!id || id === 'browser') return 'browser'
  return 'content_studio'
}

/** Read a normal assistant reply using the configured TTS backend (OS speech by default). */
export async function speakAssistantReply(
  rawText: string,
  tools?: OmegaToolsSettings
): Promise<void> {
  if (!isVoiceOutputEnabled(tools)) return
  const text = plainTextForSpeech(rawText)
  if (!text) return

  const mode = resolveVoiceTtsMode(tools)
  if (mode === 'browser') {
    if (!speechSynthesisAvailable()) return
    speakText(text)
    return
  }

  // Local neural TTS is heavy; fall back to OS speech so replies still work without GPU setup.
  if (speechSynthesisAvailable()) {
    speakText(text)
  }
}
