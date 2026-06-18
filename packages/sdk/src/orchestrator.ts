/** Orchestrator turn planner output mode. */
export type OrchestratorTurnMode = 'reply' | 'plan'

export interface OrchestratorPlan {
  mode: OrchestratorTurnMode
  briefing?: string
  tools: string[]
  response?: string
}

export type OrchestratorToolDomain =
  | 'chat'
  | 'web'
  | 'content'
  | 'files'
  | 'media'
  | 'inference'
  | 'browser'
  | 'plugins'
  | 'workforce'
  | 'other'

export interface OrchestratorToolCard {
  usage: string
  examples?: string[]
  permissions?: string[]
}

export interface OrchestratorToolGroupEntry {
  name: string
  description: string
  enabled?: boolean
  source?: string
}

export interface OrchestratorToolGroup {
  id: string
  label: string
  tools: OrchestratorToolGroupEntry[]
}
