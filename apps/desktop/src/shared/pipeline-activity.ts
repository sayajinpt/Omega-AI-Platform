/** Live “who is doing what” snapshot for the companion / chat UI. */
export type PipelineSubsystem =
  | 'idle'
  | 'chat_llm'
  | 'router_embed'
  | 'router_rerank'
  | 'content_studio'
  | 'omega_runtime'

export type PipelineActivity = {
  subsystem: PipelineSubsystem
  /** Short chip label, e.g. “Content Studio”. */
  label: string
  /** Human stage, e.g. “Image diffusion (scene 2)”. */
  stage: string
  detail?: string
  modelId?: string
  jobId?: string
  progress?: { current: number; total: number; unit?: string }
  updatedAt: number
}

export const PIPELINE_SUBSYSTEM_LABEL: Record<PipelineSubsystem, string> = {
  idle: 'Idle',
  chat_llm: 'Chat LLM',
  router_embed: 'Router embed',
  router_rerank: 'Router rerank',
  content_studio: 'Content Studio',
  omega_runtime: 'Omega runtime'
}
