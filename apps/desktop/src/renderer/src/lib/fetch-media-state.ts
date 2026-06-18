import { DEFAULT_NATIVE_RUNTIME_PORT, nativeRuntimeBaseUrl } from '@omega/sdk'

export type MediaPlayerState = {
  kind: string
  title: string
  url?: string
  watchUrl?: string
  embedUrl?: string
  path?: string
  directUrl?: string
  playing?: boolean
  embedInChat?: boolean
  previewType?: 'image' | 'video' | 'audio' | 'web' | 'file'
  sessionId?: string
  mediaRef?: string
}

/** Pull current media player state (covers missed push events during agent turns). */
export async function fetchMediaPlayerState(
  port = DEFAULT_NATIVE_RUNTIME_PORT
): Promise<MediaPlayerState | null> {
  try {
    const res = await fetch(`${nativeRuntimeBaseUrl(port)}/v1/media/state`)
    if (!res.ok) return null
    const body = (await res.json()) as MediaPlayerState & { ok?: boolean }
    if (body.kind === 'idle') return null
    return body
  } catch {
    return null
  }
}
