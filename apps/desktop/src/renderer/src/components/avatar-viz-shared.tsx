import type { AvatarNeuralActivity } from '../lib/avatar-neural-activity'
import type { AvatarSignals } from '../../../shared/avatar-signals'

export type CompanionAvatarVizProps = {
  signals: AvatarSignals
  activity: AvatarNeuralActivity
  uiScale?: number
  hideBottomBadges?: boolean
}

const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  loading: 'Load weights',
  prefill: 'Attention · prefill',
  decode: 'Decode · KV',
  retrieval: 'Retrieval',
  tool: 'Tool I/O'
}

export function AvatarPhaseBadges({
  signals,
  activity,
  uiScale = 1
}: Pick<CompanionAvatarVizProps, 'signals' | 'activity' | 'uiScale'>) {
  const badgePx = Math.max(7, Math.round(8 * uiScale))
  const padY = Math.max(1, Math.round(2 * uiScale))
  const padX = Math.max(4, Math.round(6 * uiScale))
  const phaseLabel = PHASE_LABELS[activity.phase] ?? activity.phase
  const gpuLabel =
    activity.gpuLayersVisual >= 8
      ? 'all GPU'
      : activity.gpuLayersVisual > 0
        ? `L0–L${activity.gpuLayersVisual - 1} GPU`
        : 'CPU'
  const layersLabel =
    activity.activeModel && activity.totalLayers > 0 ? `${activity.totalLayers} layers` : null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-1 flex flex-wrap justify-center gap-1 px-1">
      <span
        className="rounded bg-zinc-950/80 font-medium text-cyan-300/90 ring-1 ring-cyan-500/25"
        style={{ fontSize: badgePx, padding: `${padY}px ${padX}px` }}
      >
        {phaseLabel}
      </span>
      <span
        className="rounded bg-zinc-950/80 text-indigo-300/80 ring-1 ring-indigo-500/20"
        style={{ fontSize: badgePx, padding: `${padY}px ${padX}px` }}
      >
        {gpuLabel}
      </span>
      {layersLabel && (
        <span
          className="rounded bg-zinc-950/80 text-zinc-400 ring-1 ring-zinc-600/30"
          style={{ fontSize: badgePx, padding: `${padY}px ${padX}px` }}
        >
          {layersLabel}
        </span>
      )}
      {activity.phase === 'loading' && (
        <span
          className="rounded bg-zinc-950/80 tabular-nums text-violet-300/90"
          style={{ fontSize: badgePx, padding: `${padY}px ${padX}px` }}
        >
          {Math.round(activity.loadPercent)}%
        </span>
      )}
      {signals.state === 'error' && (
        <span
          className="rounded bg-rose-950/80 text-rose-300 ring-1 ring-rose-500/30"
          style={{ fontSize: badgePx, padding: `${padY}px ${padX}px` }}
        >
          Error
        </span>
      )}
    </div>
  )
}
