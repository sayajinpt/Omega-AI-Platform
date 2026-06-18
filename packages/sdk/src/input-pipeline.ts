import type { OrchestratorPromptOverrides } from './orchestrator-prompts.js'

/** Input pipeline scope — which app surface uses the pipeline. */
export type InputPipelineScope = 'chat' | 'content' | 'custom'

export type PipelineNode =
  | {
      id: string
      kind: 'user_input'
      label: string
    }
  | {
      id: string
      kind: 'chat_orchestrator'
      label: string
      modelId?: string
      systemAddendum?: string
      /** User copy of orchestrator prompts; defaults stay in runtime until restored. */
      promptOverrides?: OrchestratorPromptOverrides
      /**
       * Advanced: two-phase PROMPT_1 plan → PROMPT_2 execute with `<omega_turn>` markup.
       * Off by default — agent mode uses the universal multi-format tool loop instead.
       */
      twoPhaseEnabled?: boolean
    }
  | {
      id: string
      kind: 'proxy_model'
      label: string
      modelId: string
      adapterPath?: string
      promptTemplate?: string
    }
  | {
      id: string
      kind: 'tts_model'
      label: string
      modelId?: string
    }
  | {
      id: string
      kind: 'image_model'
      label: string
      modelId?: string
    }

export interface PipelineEdge {
  from: string
  to: string
}

export interface InputPipeline {
  id: string
  name: string
  description?: string
  scope: InputPipelineScope
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  /** Visual editor positions keyed by node id. */
  layout?: Record<string, { x: number; y: number }>
  /** Custom context rules appended to orchestrator PROMPT_1. */
  contextRules?: string[]
  /** Built-in defaults (Chat / Content Studio) — not deletable. */
  builtin?: boolean
  updatedAt: number
}

export interface ResolvedPipelinePath {
  pipeline: InputPipeline
  /** True when chat_orchestrator is directly after user_input (no proxy in between). */
  orchestratorActive: boolean
  /** Pipeline orchestrator node (prompt addendum, optional two-phase planning). */
  orchestratorNode?: Extract<PipelineNode, { kind: 'chat_orchestrator' }>
  proxyNodes: Extract<PipelineNode, { kind: 'proxy_model' }>[]
  ttsNode?: Extract<PipelineNode, { kind: 'tts_model' }>
  imageNode?: Extract<PipelineNode, { kind: 'image_model' }>
}
