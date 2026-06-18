import type { ModelConfig } from '@omega/sdk'
import { engineClient } from './engine'

/**
 * Whether chat should ask the engine for chain-of-thought on this request.
 * Model-agnostic: when unset, we opt in and let the template/engine no-op if unsupported.
 */
export function enableThinkingFromConfig(_modelId: string, cfg: ModelConfig): boolean {
  if (cfg.fastResponse) return false
  if (cfg.enableThinking === false) return false
  if (cfg.enableThinking === true) return true
  // Default off — engine only opts in when the template supports it and user enables it.
  return false
}

export async function resolveEnableThinkingForModel(modelId: string): Promise<boolean> {
  try {
    const cfg = await engineClient.modelConfig.get(modelId)
    return enableThinkingFromConfig(modelId, cfg)
  } catch {
    return false
  }
}
