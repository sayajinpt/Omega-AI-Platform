/**
 * Native WebView2 shell bootstrap — exposes window.omega via HTTP to omega-runtime (:9877).
 */
import { createOmegaHttpBridge, dispatchShellEvent } from '../shared/omega-http-bridge'
import { createOmegaApi } from '../shared/omega-api'

const root = globalThis as typeof globalThis & {
  omega?: ReturnType<typeof createOmegaApi>
  chrome?: { webview?: { addEventListener: (type: string, cb: (ev: MessageEvent) => void) => void } }
}

if (!root.omega) {
  root.omega = createOmegaApi(createOmegaHttpBridge({}))
}

const webview = root.chrome?.webview
if (webview) {
  webview.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; channel?: string; payload?: unknown }
    if (data?.type === 'omega-shell-event' && typeof data.channel === 'string') {
      dispatchShellEvent(data.channel, data.payload)
    }
  })
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const data = event.data as { type?: string; channel?: string; payload?: unknown }
  if (data?.type === 'omega-shell-event' && typeof data.channel === 'string') {
    dispatchShellEvent(data.channel, data.payload)
  }
})
