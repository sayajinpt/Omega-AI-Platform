export interface AgentErrorHint {
  title: string
  message: string
  actions: Array<{ label: string; page?: string; hint?: string }>
}

/** Turn raw runtime/chat/gateway errors into actionable UI copy. */
export function formatAgentError(
  raw: string,
  context: 'chat' | 'model' | 'gateway' | 'runtime' = 'chat'
): AgentErrorHint {
  const lower = raw.toLowerCase()

  if (lower.includes('file-uri-to-path') || lower.includes('better-sqlite3')) {
    return {
      title: 'Database module missing',
      message:
        'The chat database could not load. Rebuild and reinstall Omega so SQLite bindings are packaged correctly.',
      actions: [{ label: 'Open Settings', page: 'settings' }]
    }
  }

  if (lower.includes('http 429') || lower.includes('rate limit')) {
    return {
      title: 'Cloud API rate limit',
      message:
        raw.includes('OpenRouter') || lower.includes('openrouter')
          ? 'OpenRouter returned HTTP 429 (too many requests). Free models are limited — wait 30–60 seconds, avoid rapid retries, add credits at openrouter.ai, or pick a paid model. With Agent mode on, each tool round is another API call; for simple chat, turn Agent off in Session options.'
          : 'The cloud provider returned HTTP 429 (too many requests). Wait a minute and try again, or use a local GGUF model.',
      actions: [{ label: 'Providers', page: 'providers' }]
    }
  }

  if (lower.includes('http 401') || lower.includes('unauthorized') || lower.includes('api key')) {
    return {
      title: 'Invalid API key',
      message: 'The provider rejected your API key. Open Providers, paste a valid key, and fetch models again.',
      actions: [{ label: 'Providers', page: 'providers' }]
    }
  }

  if (lower.includes('http 402') || lower.includes('payment required') || lower.includes('needs billing')) {
    return {
      title: 'Provider needs credits',
      message: 'This cloud account has no credits or billing. Add credits on the provider website or choose another model.',
      actions: [{ label: 'Providers', page: 'providers' }]
    }
  }

  if (
    /^model not found:\s*[\w-]+\//i.test(lower) ||
    lower.includes('unknown remote model') ||
    lower.includes('provider not found')
  ) {
    return {
      title: 'Cloud API model unavailable',
      message:
        'This provider model is not configured or disabled. Open Providers, verify your API key, and fetch models again.',
      actions: [{ label: 'Providers', page: 'providers' }]
    }
  }

  if (
    lower.includes('no model selected') ||
    lower.includes('empty model') ||
    (lower.includes('no model') && !lower.includes('remote'))
  ) {
    return {
      title: 'No model loaded',
      message: 'Pick a model in the chat bar or download a GGUF in Model Studio, then load it into memory.',
      actions: [
        { label: 'Model Studio', page: 'models' },
        { label: 'Installed models', page: 'installed-models' }
      ]
    }
  }

  if (lower.includes('failed to load model')) {
    return {
      title: 'Model load failed',
      message:
        'The weights did not fit in GPU/RAM or MTP needs omega-infer. Try fewer GPU layers, a smaller quant, or disable speculative decoding.',
      actions: [
        { label: 'Installed models', page: 'installed-models' },
        { label: 'Settings', page: 'settings' }
      ]
    }
  }

  if (
    lower.includes('out of memory') ||
    lower.includes('oom') ||
    lower.includes('cuda') && lower.includes('memory') ||
    lower.includes('vram') ||
    lower.includes('allocation failed')
  ) {
    return {
      title: 'Not enough GPU/RAM',
      message:
        'This model does not fit in memory. Try a smaller quant (Q4_K_M), fewer GPU layers in Settings, or unload the current model first.',
      actions: [
        { label: 'Installed models', page: 'installed-models' },
        { label: 'Settings', page: 'settings', hint: 'Reduce gpuLayers or maxContextTokens' }
      ]
    }
  }

  if (lower.includes('econnrefused') || lower.includes('runtime') && lower.includes('not')) {
    return {
      title: 'Inference runtime unavailable',
      message:
        'Omega could not reach the local inference backend. Wait a few seconds and retry, or restart the app.',
      actions: [{ label: 'Debug', page: 'debug' }]
    }
  }

  if (lower.includes('ollama') && (lower.includes('connect') || lower.includes('refused'))) {
    return {
      title: 'Ollama not reachable',
      message: 'Start Ollama on this machine or switch to a local GGUF model in Installed models.',
      actions: [{ label: 'Installed models', page: 'installed-models' }]
    }
  }

  if (context === 'gateway' || lower.includes('token') && lower.includes('invalid')) {
    return {
      title: 'Gateway configuration',
      message: raw || 'Check bot token, webhook URL, and that the platform adapter is enabled.',
      actions: [{ label: 'Gateway settings', page: 'gateway' }]
    }
  }

  if (lower.includes('vision') || lower.includes('multimodal')) {
    return {
      title: 'Vision not supported',
      message: raw,
      actions: [{ label: 'Model Studio', page: 'models', hint: 'Use a vision-capable GGUF' }]
    }
  }

  if (lower.includes('abort') || lower.includes('cancelled')) {
    return {
      title: 'Stopped',
      message: 'Generation was cancelled.',
      actions: []
    }
  }

  if (
    lower.includes('signal timed out') ||
    lower.includes('aborted due to timeout') ||
    lower.includes('the operation was aborted')
  ) {
    return {
      title: 'Request timed out',
      message:
        'Omega runtime did not respond in time (often while a model is loading or chat is still running). Stop media playback, wait for chat to finish, or restart Omega.',
      actions: [{ label: 'Debug', page: 'debug' }]
    }
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      title: 'Timed out',
      message: raw,
      actions: [{ label: 'Debug', page: 'debug' }]
    }
  }

  return {
    title: context === 'chat' ? 'Chat error' : context === 'model' ? 'Model error' : 'Error',
    message: raw,
    actions:
      context === 'chat'
        ? [{ label: 'Models', page: 'installed-models' }]
        : [{ label: 'Settings', page: 'settings' }]
  }
}
