import {
  DEFAULT_NATIVE_RUNTIME_HOST,
  DEFAULT_NATIVE_RUNTIME_PORT,
  nativeRuntimeBaseUrl
} from './runtime-api.js'

/** Same-origin path when UI is served from the WebView2 shell (proxies media to runtime). */
function runtimeMediaPath(pathWithQuery: string, port: number, host: string): string {
  if (typeof globalThis !== 'undefined' && 'location' in globalThis) {
    const loc = (globalThis as Window & typeof globalThis).location
    if (loc.protocol.startsWith('http') && loc.hostname === '127.0.0.1' && loc.port === '9777') {
      return pathWithQuery
    }
  }
  return `${nativeRuntimeBaseUrl(port, host)}${pathWithQuery}`
}

/** Stream session media (video/audio/image) from omega-runtime. */
export function sessionMediaUrl(
  sessionId: string,
  ref: string,
  port: number = DEFAULT_NATIVE_RUNTIME_PORT,
  host: string = DEFAULT_NATIVE_RUNTIME_HOST
): string {
  const qs = new URLSearchParams({ sessionId, ref })
  return runtimeMediaPath(`/v1/sessions/media?${qs}`, port, host)
}

/** Stream a finished Content Studio job MP4 (works even before session import). */
export function contentStudioJobMediaUrl(
  projectId: string,
  jobId: string,
  port: number = DEFAULT_NATIVE_RUNTIME_PORT,
  host: string = DEFAULT_NATIVE_RUNTIME_HOST
): string {
  const qs = new URLSearchParams({ projectId, jobId })
  return runtimeMediaPath(`/v1/content-studio/jobMedia?${qs}`, port, host)
}
