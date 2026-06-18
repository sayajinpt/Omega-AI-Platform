import { useState } from 'react'
import type { AgentStep } from '@omega/sdk'
import { AgentGraph } from './AgentGraph'
import { usePipelineActivity } from '../lib/use-pipeline-activity'
import { PIPELINE_SUBSYSTEM_LABEL } from '../../../shared/pipeline-activity'
import type { PipelineSubsystem } from '../../../shared/pipeline-activity'

const KIND_DOT: Record<AgentStep['kind'], string> = {
  plan: 'bg-indigo-400',
  execute: 'bg-sky-400',
  tool: 'bg-amber-400',
  critic: 'bg-fuchsia-400',
  respond: 'bg-emerald-400'
}

const PIPELINE_CHIP: Record<PipelineSubsystem, string> = {
  idle: 'bg-zinc-800 text-zinc-500',
  chat_llm: 'bg-indigo-950/80 text-indigo-200',
  router_embed: 'bg-violet-950/70 text-violet-200',
  router_rerank: 'bg-fuchsia-950/70 text-fuchsia-200',
  content_studio: 'bg-amber-950/70 text-amber-200',
  omega_runtime: 'bg-sky-950/70 text-sky-200'
}

/** Compact live agent steps — same stream as Agent page and Office. */
export function AgentStepStrip({
  steps,
  onClear,
  onOpenAgent
}: {
  steps: AgentStep[]
  onClear?: () => void
  onOpenAgent?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const pipeline = usePipelineActivity()
  const showPipeline = Boolean(pipeline && pipeline.subsystem !== 'idle')
  if (!showPipeline && steps.length === 0) return null

  const running = steps.filter((s) => s.status === 'running').length
  const latest = steps[steps.length - 1]

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/80 px-3 py-2">
      {showPipeline && pipeline && (
        <div className="mb-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                PIPELINE_CHIP[pipeline.subsystem] ?? PIPELINE_CHIP.idle
              }`}
            >
              {PIPELINE_SUBSYSTEM_LABEL[pipeline.subsystem]}
            </span>
            {pipeline.modelId && pipeline.subsystem === 'chat_llm' && (
              <span className="truncate text-[10px] text-zinc-500" title={pipeline.modelId}>
                {pipeline.modelId}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] font-medium text-zinc-200">{pipeline.stage}</p>
          {pipeline.detail && (
            <p className="mt-0.5 line-clamp-2 text-[10px] text-zinc-500">{pipeline.detail}</p>
          )}
          {pipeline.progress && pipeline.progress.total > 0 && (
            <>
              <p className="mt-1 text-[10px] tabular-nums text-zinc-500">
                {pipeline.progress.current} / {pipeline.progress.total}
                {pipeline.progress.unit ? ` ${pipeline.progress.unit}` : ''}
              </p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-amber-500/90 transition-[width] duration-300"
                  style={{
                    width: `${Math.min(100, Math.round((pipeline.progress.current / pipeline.progress.total) * 100))}%`
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}
      {steps.length > 0 && (
      <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-zinc-300 hover:text-zinc-100"
        >
          <span className="font-medium text-indigo-300">Agent activity</span>
          {running > 0 && (
            <span className="animate-pulse rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">
              {running} running
            </span>
          )}
          {latest && (
            <span className="truncate text-zinc-500">
              {latest.kind}: {latest.title}
            </span>
          )}
        </button>
        <div className="flex gap-1">
          {onOpenAgent && (
            <button
              type="button"
              onClick={onOpenAgent}
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
            >
              Full graph
            </button>
          )}
          {onClear && steps.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {!expanded && steps.length > 0 && (
        <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
          {steps.slice(-8).map((s) => (
            <span
              key={s.id}
              title={`${s.kind}: ${s.title}`}
              className={`inline-flex shrink-0 items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] ${
                s.status === 'error' ? 'border-rose-800 text-rose-300' : 'text-zinc-500'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[s.kind] ?? 'bg-zinc-500'}`} />
              {s.kind}
            </span>
          ))}
        </div>
      )}
      {expanded && (
        <div className="mt-2 max-h-48 overflow-y-auto">
          <AgentGraph steps={steps} />
        </div>
      )}
      </>
      )}
    </div>
  )
}
