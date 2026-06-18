import { useEffect, useState } from 'react'
import type { AvatarNeuralActivity } from '../lib/avatar-neural-activity'
import { useAvatarInferenceMetrics, useAvatarStreamViz } from '../lib/avatar-stream-viz'
import { formatTokPerSec, resolveTokenSpeedRates } from '../lib/token-speed-display'
import {
  formatContextTokensLabel,
  onContextTokens,
  type ContextTokensState
} from '../lib/context-tokens-bridge'

const PIPELINE = [
  { id: 'tok', label: 'Tokenize' },
  { id: 'emb', label: 'Embed' },
  { id: 'attn', label: 'Attention' },
  { id: 'mlp', label: 'MLP' },
  { id: 'res', label: 'Residual' },
  { id: 'norm', label: 'Norm' },
  { id: 'log', label: 'Logits' },
  { id: 'samp', label: 'Sample' }
] as const

const BACKEND_LABEL: Record<string, string> = {
  native: 'native KV + logits',
  runtime: 'runtime (estimated)',
  ollama: 'Ollama (estimated)',
  remote: 'remote (estimated)',
  estimated: 'stream estimate'
}

function activeStepIndex(
  phase: AvatarNeuralActivity['phase'],
  streamPhase: 'idle' | 'prefill' | 'decode'
): number {
  if (phase === 'loading') return 1
  if (streamPhase === 'prefill' || phase === 'prefill') return 2
  if (streamPhase === 'decode' || phase === 'decode') return 7
  if (phase === 'retrieval' || phase === 'tool') return 2
  return 0
}

/** Compute-trace HUD — native metrics when available; honest labels otherwise. */
export function CompanionVizPanel({
  activity,
  uiScale,
  compact = false
}: {
  activity: AvatarNeuralActivity
  uiScale: number
  /** Overlay inside the 3D square — minimal chrome. */
  compact?: boolean
}) {
  const stream = useAvatarStreamViz()
  const measured = useAvatarInferenceMetrics()
  const speeds = resolveTokenSpeedRates(stream, measured)
  const [ctxTokens, setCtxTokens] = useState<ContextTokensState>(() => ({
    sessionId: null,
    tokenEstimate: 0,
    maxContext: 0,
    messageCount: 0
  }))
  useEffect(() => onContextTokens(setCtxTokens), [])
  const fontPx = Math.max(8, Math.round(9 * uiScale))
  const ctxLabel = formatContextTokensLabel(ctxTokens)
  const stepIdx = activeStepIndex(activity.phase, stream.phase)

  const kvTokens =
    measured?.kvTokens ??
    (typeof measured?.promptTokens === 'number' && typeof measured?.completionTokens === 'number'
      ? measured.promptTokens + measured.completionTokens
      : stream.decodeTokens)
  const ctxSize = measured?.contextSize ?? 4096
  const kvPct = ctxSize > 0 ? Math.min(100, Math.round((kvTokens / ctxSize) * 100)) : 0

  const confidence =
    measured?.confidence ?? measured?.topK[0]?.probability ?? stream.confidence
  const entropy = measured?.entropy
  const backend = measured?.backend ?? 'estimated'
  const sourceLabel = BACKEND_LABEL[backend] ?? backend

  const affinity = measured?.contextAffinity ?? []
  const affinityLabels = measured?.contextAffinityLabels ?? []
  const gridN = affinity.length > 0 ? affinity.length : 6
  const useMeasuredAffinity = affinity.length > 0

  const fallbackAttn = Array.from({ length: 36 }, (_, i) => {
    const row = Math.floor(i / 6)
    const col = i % 6
    const seed = (stream.decodeTokens * 7 + row * 11 + col * 13) % 100
    return stream.phase !== 'idle' && seed < 18 + stream.confidence * 40
  })

  if (compact) {
    return (
      <div className="pointer-events-none space-y-1 p-1" style={{ fontSize: fontPx }}>
        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded bg-zinc-950/70 px-1 py-0.5 text-[8px] uppercase text-zinc-400">
            {sourceLabel}
          </span>
          {ctxLabel && (
            <span className="tabular-nums text-[8px] text-zinc-400" title="Chat context fill">
              ctx {ctxLabel}
            </span>
          )}
          <span className="tabular-nums text-[8px] text-cyan-300/90">
            KV {kvTokens}
            {ctxSize > 0 ? `/${ctxSize}` : ''}
          </span>
          <span className="tabular-nums text-[8px] text-amber-200/90">
            {Math.round(confidence * 100)}%
          </span>
          <span
            className="text-[8px] text-amber-200/80"
            title="Prompt speed (input processing)"
          >
            in {formatTokPerSec(speeds.active && speeds.phase === 'prefill' ? speeds.promptLive : speeds.promptPeak)}
          </span>
          <span
            className="text-[8px] text-emerald-300/80"
            title="Generation speed (output)"
          >
            out {formatTokPerSec(speeds.active && speeds.phase === 'decode' ? speeds.generationLive : speeds.generationPeak)}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-900/80">
          <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${kvPct}%` }} />
        </div>
        {measured && measured.topK.length > 0 && (
          <p className="truncate font-mono text-[8px] text-emerald-300/80" title={measured.topK[0]?.text}>
            → {measured.topK[0]?.text.replace(/\s/g, '·')} ({Math.round((measured.topK[0]?.probability ?? 0) * 100)}%)
          </p>
        )}
        <div className="flex flex-wrap gap-0.5 opacity-90">
          {PIPELINE.map((step, i) => (
            <span
              key={step.id}
              className={`rounded px-0.5 text-[7px] ${
                i === stepIdx ? 'bg-cyan-600/40 text-cyan-100' : 'text-zinc-600'
              }`}
            >
              {step.label.slice(0, 4)}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2" style={{ fontSize: fontPx }}>
      <p className="text-[10px] leading-snug text-zinc-500">
        Tensor pipeline & next-token distribution. KV and top-k are measured on native GGUF when
        available. Context grid is token-ID affinity, not attention weights.
      </p>

      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-zinc-400">
          {sourceLabel}
        </span>
        {measured?.activeLayer != null && measured.totalLayers != null && (
          <span className="text-[9px] text-zinc-500">
            layer {measured.activeLayer + 1}/{measured.totalLayers}
          </span>
        )}
        {measured?.gpuLayers != null && measured.gpuLayers > 0 && (
          <span className="text-[9px] text-zinc-500">· {measured.gpuLayers} GPU layers</span>
        )}
      </div>

      <div className="flex flex-wrap gap-0.5">
        {PIPELINE.map((step, i) => (
          <span
            key={step.id}
            className={`rounded px-1 py-0.5 ${
              i === stepIdx
                ? 'bg-cyan-600/30 text-cyan-200 ring-1 ring-cyan-500/40'
                : i < stepIdx
                  ? 'bg-zinc-800/60 text-zinc-500'
                  : 'text-zinc-600'
            }`}
          >
            {step.label}
          </span>
        ))}
      </div>

      <div>
        <div className="mb-0.5 flex justify-between text-zinc-500">
          <span>KV cache</span>
          <span className="tabular-nums text-zinc-400">
            {kvTokens}
            {ctxSize > 0 ? ` / ${ctxSize}` : ''}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-indigo-500/80 transition-[width] duration-300"
            style={{ width: `${kvPct}%` }}
          />
        </div>
      </div>

      <div>
        <div className="mb-0.5 flex justify-between text-zinc-500">
          <span>{backend === 'engine' ? 'Next-token confidence' : 'Confidence (estimate)'}</span>
          <span className="tabular-nums text-zinc-400">{Math.round(confidence * 100)}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-amber-400/80 transition-[width] duration-200"
            style={{ width: `${Math.round(confidence * 100)}%` }}
          />
        </div>
        {entropy != null && backend === 'engine' && (
          <p className="mt-0.5 text-[9px] text-zinc-500">
            entropy (norm): {Math.round(entropy * 100)}%
          </p>
        )}
        {(stream.lastToken || measured?.selectedToken) && (
          <p
            className="mt-1 truncate font-mono text-cyan-300/90"
            title={measured?.selectedToken ?? stream.lastToken}
          >
            +「{(measured?.selectedToken ?? stream.lastToken).replace(/\s/g, '·')}」
            {(speeds.promptPeak > 0 || speeds.generationPeak > 0) && (
              <>
                {' '}
                · prompt{' '}
                {formatTokPerSec(
                  speeds.active && speeds.phase === 'prefill' ? speeds.promptLive : speeds.promptPeak
                )}
                {' '}
                · gen{' '}
                {formatTokPerSec(
                  speeds.active && speeds.phase === 'decode'
                    ? speeds.generationLive
                    : speeds.generationPeak
                )}
              </>
            )}
          </p>
        )}
      </div>

      {measured && measured.topK.length > 0 && (
        <div>
          <p className="mb-1 text-zinc-500">Top-k candidates</p>
          <ul className="space-y-0.5">
            {measured.topK.slice(0, 6).map((c, i) => (
              <li key={i} className="flex items-center gap-1">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-emerald-500/70"
                    style={{ width: `${Math.round(c.probability * 100)}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right tabular-nums text-[9px] text-zinc-500">
                  {(c.probability * 100).toFixed(0)}%
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-zinc-400">
                  {c.text.replace(/\s/g, '·') || '·'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-1 text-zinc-500">
          {useMeasuredAffinity ? 'Context affinity (recent tokens)' : 'Attention proxy (stream)'}
        </p>
        {useMeasuredAffinity ? (
          <div className="overflow-x-auto">
            <div
              className="inline-grid gap-px rounded border border-zinc-800 bg-zinc-900 p-0.5"
              style={{ gridTemplateColumns: `repeat(${gridN}, minmax(0, 1fr))` }}
            >
              {affinity.flatMap((row, ri) =>
                row.map((v, ci) => (
                  <span
                    key={`${ri}-${ci}`}
                    className="aspect-square w-3 rounded-[1px]"
                    title={`${affinityLabels[ri] ?? ri} → ${affinityLabels[ci] ?? ci}`}
                    style={{
                      backgroundColor: `rgba(34, 211, 238, ${0.15 + v * 0.75})`
                    }}
                  />
                ))
              )}
            </div>
            {affinityLabels.length > 0 && (
              <p className="mt-1 truncate text-[8px] text-zinc-600">{affinityLabels.join(' · ')}</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-px rounded border border-zinc-800 bg-zinc-900 p-0.5">
            {fallbackAttn.map((hot, i) => (
              <span
                key={i}
                className="aspect-square rounded-[1px]"
                style={{
                  backgroundColor: hot
                    ? `rgba(34, 211, 238, ${0.25 + stream.confidence * 0.65})`
                    : 'rgba(39, 39, 42, 0.5)'
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
