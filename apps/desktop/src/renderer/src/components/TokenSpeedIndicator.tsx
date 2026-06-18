import { useAvatarInferenceMetrics, useAvatarStreamViz } from '../lib/avatar-stream-viz'
import { formatTokPerSec, resolveTokenSpeedRates } from '../lib/token-speed-display'

function SpeedPill({
  label,
  sublabel,
  rate,
  peak,
  active,
  tone,
  compact = false
}: {
  label: string
  sublabel: string
  rate: number
  peak: number
  active: boolean
  tone: 'amber' | 'emerald'
  compact?: boolean
}) {
  const display = active && rate > 0 ? rate : peak > 0 ? peak : 0
  const value = formatTokPerSec(display)
  const ring =
    tone === 'amber'
      ? active
        ? 'bg-amber-950/50 text-amber-200 ring-amber-700/40'
        : 'bg-zinc-800/80 text-zinc-300 ring-zinc-600/40'
      : active
        ? 'bg-emerald-950/50 text-emerald-300 ring-emerald-700/40'
        : 'bg-zinc-800/80 text-zinc-300 ring-zinc-600/40'

  return (
    <div
      className={`flex min-w-0 flex-col items-center ${compact ? 'gap-0' : 'gap-0.5'}`}
      title={
        active
          ? `${label}: ${value} (${sublabel})`
          : peak > 0
            ? `${label} (last): ${formatTokPerSec(peak)}`
            : `${label}: waiting for model activity`
      }
    >
      <span className={`uppercase tracking-wide text-zinc-500 ${compact ? 'text-[7px]' : 'text-[8px]'}`}>
        {label}
      </span>
      <span
        className={`inline-flex items-center justify-center rounded font-medium tabular-nums ring-1 ${ring} ${
          compact ? 'min-w-[3.25rem] px-1 py-0 text-[10px]' : 'min-w-[4.5rem] px-1.5 py-0.5'
        }`}
      >
        {value}
      </span>
      {!compact && <span className="text-[7px] text-zinc-600">{sublabel}</span>}
    </div>
  )
}

/** Prompt (input) and generation (output) throughput — main window + companion top bar. */
export function TokenSpeedIndicator({
  className = '',
  compact = false
}: {
  className?: string
  compact?: boolean
}) {
  const stream = useAvatarStreamViz()
  const metrics = useAvatarInferenceMetrics()
  const rates = resolveTokenSpeedRates(stream, metrics)

  if (compact) {
    return (
      <div className={`flex shrink-0 items-center gap-1.5 tabular-nums ${className}`}>
        <SpeedPill
          label="In"
          sublabel="prompt"
          rate={rates.promptLive}
          peak={rates.promptPeak}
          active={rates.active && rates.promptLive > 0}
          tone="amber"
          compact
        />
        <SpeedPill
          label="Out"
          sublabel="gen"
          rate={rates.generationLive}
          peak={rates.generationPeak}
          active={rates.active && rates.generationLive > 0}
          tone="emerald"
          compact
        />
      </div>
    )
  }

  return (
    <div
      className={`flex flex-wrap items-end gap-3 tabular-nums ${className}`}
      title="Prompt speed = input processing (prefill). Generation speed = output tokens (decode)."
    >
      <SpeedPill
        label="Prompt speed"
        sublabel="input processing"
        rate={rates.promptLive}
        peak={rates.promptPeak}
        active={rates.active && rates.promptLive > 0}
        tone="amber"
      />
      <SpeedPill
        label="Generation speed"
        sublabel="output speed"
        rate={rates.generationLive}
        peak={rates.generationPeak}
        active={rates.active && rates.generationLive > 0}
        tone="emerald"
      />
    </div>
  )
}
