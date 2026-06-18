/** User overrides for LLM orchestrator PROMPT_1 / PROMPT_2 (stored on chat_orchestrator node). */
export interface OrchestratorPromptOverrides {
  /** PROMPT_1 plan instructions (INSTRUCTION_1…4). */
  planInstructions?: string
  /** PROMPT_1 context rules block. */
  contextRules?: string
  /** PROMPT_1 CHAT_TOOLS section. */
  chatTools?: string
  /** PROMPT_1 AGENT_TOOLS section. */
  agentTools?: string
  /** PROMPT_2 execute instructions (default for all execute rounds). */
  executeInstructions?: string
  /** User message after tool results between execute rounds. */
  toolResultsContinuation?: string
  /** Per execute-round instruction overrides (round 2, 3, …). */
  executeRounds?: OrchestratorExecuteRound[]
}

export interface OrchestratorExecuteRound {
  id: string
  label: string
  /** Replaces execute instructions for this round only. */
  instructions?: string
}

/** Built-in defaults from omega-runtime (read-only; never mutated). */
export interface OrchestratorPromptDefaults {
  planInstructions: string
  contextRules: string
  chatTools: string
  agentTools: string
  executeInstructions: string
  toolResultsContinuation: string
}

export function emptyOrchestratorPromptOverrides(): OrchestratorPromptOverrides {
  return {}
}

/** True when any override field is set. */
export function orchestratorPromptsCustomized(o?: OrchestratorPromptOverrides): boolean {
  if (!o) return false
  if (o.planInstructions?.trim()) return true
  if (o.contextRules?.trim()) return true
  if (o.chatTools?.trim()) return true
  if (o.agentTools?.trim()) return true
  if (o.executeInstructions?.trim()) return true
  if (o.toolResultsContinuation?.trim()) return true
  if (o.executeRounds?.some((r) => r.instructions?.trim())) return true
  return false
}
