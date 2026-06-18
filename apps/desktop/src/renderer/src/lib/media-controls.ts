import { contentStudioJobMediaUrl } from '@omega/sdk'
import { engineClient } from './engine'

export const MEDIA_LOCAL_IDLE_EVENT = 'omega:media-local-idle'
export const MEDIA_LOCAL_PAUSE_EVENT = 'omega:media-local-pause'
export const MEDIA_LOCAL_RESUME_EVENT = 'omega:media-local-resume'
export const MEDIA_LOCAL_PREVIEW_EVENT = 'omega:media-local-preview'

type LocalPreviewDetail = {
  kind: 'preview'
  previewType: 'image' | 'video' | 'audio' | 'file'
  sessionId: string
  mediaRef: string
  title: string
  playing?: boolean
  embedInChat?: boolean
  /** Play directly from runtime (session or Content Studio job URL). */
  directUrl?: string
}

/** Open the in-chat player without waiting on omega-runtime (e.g. during model reload). */
export function previewSessionMediaInChat(
  sessionId: string,
  part: { type: 'video' | 'audio' | 'image'; ref: string; alt?: string }
): void {
  const detail: LocalPreviewDetail = {
    kind: 'preview',
    previewType: part.type,
    sessionId,
    mediaRef: part.ref,
    title:
      part.type === 'image'
        ? (part.alt ?? 'Image')
        : part.type === 'video'
          ? 'Generated video'
          : 'Generated audio',
    playing: part.type !== 'image',
    embedInChat: true
  }
  window.dispatchEvent(new CustomEvent(MEDIA_LOCAL_PREVIEW_EVENT, { detail }))
}

/** Open a finished Content Studio render in the chat player (reads final.mp4 from storage). */
export function previewContentStudioJobInChat(
  sessionId: string,
  projectId: string,
  jobId: string,
  title?: string
): void {
  const detail: LocalPreviewDetail = {
    kind: 'preview',
    previewType: 'video',
    sessionId,
    mediaRef: '',
    directUrl: contentStudioJobMediaUrl(projectId, jobId),
    title: title ?? 'Generated video',
    playing: true,
    embedInChat: true
  }
  window.dispatchEvent(new CustomEvent(MEDIA_LOCAL_PREVIEW_EVENT, { detail }))
}

/** Fired before runtime stop; ChatPage aborts an in-flight agent stream when the user hits Stop. */
export const MEDIA_STOP_REQUEST_EVENT = 'omega:media-stop-request'

export function dispatchMediaControlError(message: string): void {
  window.dispatchEvent(new CustomEvent('omega:media-control-error', { detail: message }))
}

/** Stop in-UI playback immediately (HTML audio/video) before waiting on runtime/shell. */
export function applyLocalMediaTransport(kind: 'stop' | 'pause' | 'resume'): void {
  const name =
    kind === 'stop'
      ? MEDIA_LOCAL_IDLE_EVENT
      : kind === 'pause'
        ? MEDIA_LOCAL_PAUSE_EVENT
        : MEDIA_LOCAL_RESUME_EVENT
  window.dispatchEvent(new CustomEvent(name))
}

/** Halt WebView2 / YouTube playback (hide alone leaves audio running). */
async function stopEmbeddedBrowserPlayback(): Promise<void> {
  const cmd = (action: 'stop' | 'pause' | 'resume' | 'play') =>
    engineClient.browser.mediaCommand({ action }).catch(() => undefined)
  await cmd('stop')
  await engineClient.browser.navigate('about:blank').catch(() => undefined)
  void engineClient.browser.hide()
}

export async function mediaStop(): Promise<void> {
  window.dispatchEvent(new CustomEvent(MEDIA_STOP_REQUEST_EVENT))
  applyLocalMediaTransport('stop')
  void stopEmbeddedBrowserPlayback()
  try {
    await engineClient.media.stop()
  } catch (e) {
    dispatchMediaControlError(e instanceof Error ? e.message : String(e))
    throw e
  }
}

export async function mediaPause(): Promise<void> {
  applyLocalMediaTransport('pause')
  try {
    await engineClient.media.pause()
  } catch (e) {
    dispatchMediaControlError(e instanceof Error ? e.message : String(e))
    throw e
  }
}

export async function mediaResume(): Promise<void> {
  applyLocalMediaTransport('resume')
  try {
    await engineClient.media.resume()
  } catch (e) {
    dispatchMediaControlError(e instanceof Error ? e.message : String(e))
    throw e
  }
}
