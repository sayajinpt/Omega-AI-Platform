import type { PipelineActivity, PipelineSubsystem } from '../../../shared/pipeline-activity'
import { PIPELINE_SUBSYSTEM_LABEL } from '../../../shared/pipeline-activity'
import { usePipelineActivity } from '../lib/use-pipeline-activity'

const CHIP: Record<PipelineSubsystem, string> = {
  idle: 'bg-zinc-800 text-zinc-500',
  chat_llm: 'bg-indigo-950/80 text-indigo-200',
  router_embed: 'bg-violet-950/70 text-violet-200',
  router_rerank: 'bg-fuchsia-950/70 text-fuchsia-200',
  content_studio: 'bg-amber-950/70 text-amber-200',
  omega_runtime: 'bg-sky-950/70 text-sky-200'
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
      <div
        className="h-full rounded-full bg-amber-500/90 transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function HudBody({ activity, compact }: { activity: PipelineActivity; compact?: boolean }) {
  const sub = activity.subsystem
  const chip = CHIP[sub] ?? CHIP.idle
  return (
    <div
      className={`rounded-lg border border-zinc-800 bg-zinc-950/90 ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${chip}`}>
          {PIPELINE_SUBSYSTEM_LABEL[sub]}
        </span>
        {activity.modelId && (
          <span className="truncate text-[10px] text-zinc-500" title={activity.modelId}>
            {activity.modelId}
          </span>
        )}
      </div>
      <p className={`mt-1 font-medium text-zinc-200 ${compact ? 'text-[11px]' : 'text-xs'}`}>
        {activity.stage}
      </p>
      {activity.detail && (
        <p className="mt-0.5 line-clamp-2 text-[10px] text-zinc-500">{activity.detail}</p>
      )}
      {activity.progress && activity.progress.total > 0 && (
        <>
          <p className="mt-1 text-[10px] tabular-nums text-zinc-500">
            {activity.progress.current} / {activity.progress.total}
            {activity.progress.unit ? ` ${activity.progress.unit}` : ''}
          </p>
          <ProgressBar current={activity.progress.current} total={activity.progress.total} />
        </>
      )}
    </div>
  )
}

/** Global pipeline strip (companion / top of app). Hidden when idle. */
export function PipelineActivityHud({ compact = false }: { compact?: boolean }) {
  const activity = usePipelineActivity()
  if (!activity || activity.subsystem === 'idle') return null
  return <HudBody activity={activity} compact={compact} />
}

/** Per Content Studio job card — only shows when this job is active. */
export function PipelineActivityForJob({
  jobId,
  compact = true
}: {
  jobId: string
  compact?: boolean
}) {
  const activity = usePipelineActivity(jobId)
  if (!activity || activity.subsystem !== 'content_studio') return null
  return <HudBody activity={activity} compact={compact} />
}
