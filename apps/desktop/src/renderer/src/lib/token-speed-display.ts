import { isChatStreamActive, type AvatarStreamViz } from './avatar-stream-viz'
import type { InferenceMetricsSnapshot } from '@omega/sdk'

export type TokenSpeedRates = {
  promptLive: number
  generationLive: number
  promptPeak: number
  generationPeak: number
  phase: AvatarStreamViz['phase']
  active: boolean
}

/** Local LLM speeds above this are almost always a timing glitch — hide until fixed. */
const MAX_CREDIBLE_TOK_S = 800

export function formatTokPerSec(rate: number): string {
  if (rate <= 0) return '—'
  if (rate > MAX_CREDIBLE_TOK_S) return '—'
  return `${Math.round(rate)} tok/s`
}

function credibleRate(rate: number): number {
  return rate > 0 && rate <= MAX_CREDIBLE_TOK_S ? rate : 0
}

/** Resolve live + peak prompt/generation speeds from stream + native metrics. */
export function resolveTokenSpeedRates(
  stream: AvatarStreamViz,
  metrics: InferenceMetricsSnapshot | null
): TokenSpeedRates {
  const phase =
    !isChatStreamActive()
      ? 'idle'
      : metrics?.phase === 'prefill' || metrics?.phase === 'decode'
        ? metrics.phase
        : stream.phase
  const active = isChatStreamActive() && (phase === 'prefill' || phase === 'decode')
  const measured = metrics?.measured === true

  const promptFromMetrics = metrics?.promptTokenRate ?? 0
  const genFromMetrics = metrics?.generationTokenRate ?? 0

  const promptLive = credibleRate(
    promptFromMetrics > 0
      ? promptFromMetrics
      : measured
        ? 0
        : stream.promptTokenRate
  )
  const generationLive = credibleRate(
    genFromMetrics > 0
      ? genFromMetrics
      : measured
        ? 0
        : stream.generationTokenRate
  )

  const promptPeak = credibleRate(Math.max(stream.peakPromptTokenRate, promptLive))
  const generationPeak = credibleRate(Math.max(stream.peakGenerationTokenRate, generationLive))

  return {
    promptLive: active ? promptLive : 0,
    generationLive: active ? generationLive : 0,
    promptPeak,
    generationPeak,
    phase,
    active
  }
}
