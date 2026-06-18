import { useEffect, useState } from 'react'
import type { InferenceMetricsSnapshot } from '@omega/sdk'

/** Live prefill/decode signals from token stream + optional native inference metrics. */

export type AvatarStreamViz = {
  phase: 'idle' | 'prefill' | 'decode'
  decodeTokens: number
  lastToken: string
  /** @deprecated Use generationTokenRate — mirrors generation for legacy UI. */
  tokenRate: number
  promptTokenRate: number
  generationTokenRate: number
  peakPromptTokenRate: number
  peakGenerationTokenRate: number
  /** Peak generation tok/s from the latest burst (legacy). */
  peakTokenRate: number
  confidence: number
  updatedAt: number
}

const state: AvatarStreamViz = {
  phase: 'idle',
  decodeTokens: 0,
  lastToken: '',
  tokenRate: 0,
  promptTokenRate: 0,
  generationTokenRate: 0,
  peakPromptTokenRate: 0,
  peakGenerationTokenRate: 0,
  peakTokenRate: 0,
  confidence: 0.2,
  updatedAt: 0
}

let metrics: InferenceMetricsSnapshot | null = null
/** True while a chat stream is in flight (omega:streaming-start … end). */
let chatStreamActive = false
/** Bumps on each stream start; tokens from a prior generation are ignored after end. */
let chatStreamGeneration = 0
let activeChatStreamGeneration = 0

const streamListeners = new Set<() => void>()

function bumpStreamListeners(): void {
  state.updatedAt = Date.now()
  for (const fn of streamListeners) fn()
}

export function isChatStreamActive(): boolean {
  return chatStreamActive
}

/** Subscribe to stream viz changes (start/end/token/metrics). */
export function subscribeAvatarStreamViz(listener: () => void): () => void {
  streamListeners.add(listener)
  return () => streamListeners.delete(listener)
}

/** Companion / top bar: never show prefill-decode when the stream session has ended. */
export function effectiveAvatarSignalState(
  state: 'idle' | 'thinking' | 'speaking' | 'error'
): 'idle' | 'thinking' | 'speaking' | 'error' {
  if (!chatStreamActive && state !== 'error') return 'idle'
  return state
}

let decodeEventCount = 0
let decodeWindowStart = 0

let prefillStartedAt = 0
let prefillRateCaptured = false
let decodeStartedAt = 0

const MAX_CREDIBLE_TOK_S = 800
const MIN_RATE_WINDOW_S = 0.25

function recordPromptRate(rate: number): void {
  if (rate <= 0 || rate > MAX_CREDIBLE_TOK_S) return
  state.promptTokenRate = rate
  state.tokenRate = rate
  if (rate > state.peakPromptTokenRate) state.peakPromptTokenRate = rate
}

function recordGenerationRate(rate: number): void {
  if (rate <= 0 || rate > MAX_CREDIBLE_TOK_S) return
  state.generationTokenRate = rate
  state.tokenRate = rate
  if (rate > state.peakGenerationTokenRate) state.peakGenerationTokenRate = rate
  if (rate > state.peakTokenRate) state.peakTokenRate = rate
}

/** One IPC token event ≈ one decode step (do not scale by chunk char length). */
function bumpDecodeWindow(): void {
  const now = Date.now()
  if (!decodeWindowStart) decodeWindowStart = now
  decodeEventCount += 1
  const elapsed = (now - decodeWindowStart) / 1000
  if (elapsed >= MIN_RATE_WINDOW_S) {
    recordGenerationRate(decodeEventCount / elapsed)
    decodeEventCount = 0
    decodeWindowStart = now
  }
}

function resetRateWindows(): void {
  decodeEventCount = 0
  decodeWindowStart = 0
  prefillStartedAt = 0
  prefillRateCaptured = false
  decodeStartedAt = 0
}

export function getAvatarStreamViz(): AvatarStreamViz {
  return state
}

export function getAvatarInferenceMetrics(): InferenceMetricsSnapshot | null {
  return metrics
}

export function resetAvatarStreamViz(): void {
  chatStreamActive = false
  activeChatStreamGeneration = 0
  state.phase = 'idle'
  state.decodeTokens = 0
  state.lastToken = ''
  state.tokenRate = 0
  state.promptTokenRate = 0
  state.generationTokenRate = 0
  state.peakPromptTokenRate = 0
  state.peakGenerationTokenRate = 0
  state.peakTokenRate = 0
  state.confidence = 0.2
  state.updatedAt = Date.now()
  metrics = null
  resetRateWindows()
  bumpStreamListeners()
}

export function onAvatarStreamStart(): void {
  chatStreamActive = true
  chatStreamGeneration += 1
  activeChatStreamGeneration = chatStreamGeneration
  state.phase = 'prefill'
  state.decodeTokens = 0
  state.lastToken = ''
  state.tokenRate = 0
  state.promptTokenRate = 0
  state.generationTokenRate = 0
  state.peakPromptTokenRate = 0
  state.peakGenerationTokenRate = 0
  state.peakTokenRate = 0
  state.confidence = 0.2
  state.updatedAt = Date.now()
  metrics = null
  resetRateWindows()
  prefillStartedAt = Date.now()
  prefillRateCaptured = false
  bumpStreamListeners()
}

export function onAvatarStreamToken(text: string): void {
  if (!chatStreamActive || !text) return
  if (!decodeStartedAt) decodeStartedAt = Date.now()
  state.phase = 'decode'
  state.decodeTokens += 1
  state.lastToken = text
  if (!metrics?.measured) {
    bumpDecodeWindow()
  }
  if (!metrics || metrics.backend === 'estimated') {
    const len = Math.min(12, text.length)
    state.confidence = Math.min(
      1,
      0.35 + len / 14 + Math.min(0.35, state.generationTokenRate / 80)
    )
  }
  state.updatedAt = Date.now()
  bumpStreamListeners()
}

function applyMetricsRates(m: InferenceMetricsSnapshot): void {
  if (typeof m.promptTokenRate === 'number' && m.promptTokenRate > 0) {
    recordPromptRate(m.promptTokenRate)
    if (m.promptTokenRate > 0) prefillRateCaptured = true
  }
  if (typeof m.generationTokenRate === 'number' && m.generationTokenRate > 0) {
    recordGenerationRate(m.generationTokenRate)
  }
}

export function onAvatarInferenceMetrics(m: InferenceMetricsSnapshot): void {
  if (!chatStreamActive) return
  metrics = m
  if (m.phase === 'prefill' || m.phase === 'decode') {
    state.phase = m.phase
  } else if (m.phase === 'idle') {
    state.phase = 'idle'
  }

  const completion = m.completionTokens
  if (typeof completion === 'number' && completion > 0) {
    state.decodeTokens = completion
  } else if (m.phase === 'decode' && typeof m.kvTokens === 'number' && m.kvTokens > 0) {
    const prompt = m.promptTokens ?? 0
    state.decodeTokens = Math.max(0, m.kvTokens - prompt)
  }

  if (m.selectedToken) state.lastToken = m.selectedToken

  applyMetricsRates(m)

  if (
    !m.measured &&
    !prefillRateCaptured &&
    prefillStartedAt > 0 &&
    state.peakPromptTokenRate === 0 &&
    typeof m.promptTokens === 'number' &&
    m.promptTokens > 0
  ) {
    const elapsed = (Date.now() - prefillStartedAt) / 1000
    if (elapsed >= MIN_RATE_WINDOW_S) {
      recordPromptRate(m.promptTokens / elapsed)
      prefillRateCaptured = true
    }
  }

  if (typeof m.confidence === 'number') {
    state.confidence = m.confidence
  } else if (m.topK[0]?.probability != null) {
    state.confidence = m.topK[0].probability
  }
  state.updatedAt = Date.now()
  bumpStreamListeners()
}

export function onAvatarStreamEnd(): void {
  chatStreamActive = false
  activeChatStreamGeneration = 0
  if (!metrics?.measured && decodeStartedAt > 0 && state.decodeTokens > 0) {
    const elapsed = (Date.now() - decodeStartedAt) / 1000
    if (elapsed >= MIN_RATE_WINDOW_S) {
      recordGenerationRate(state.decodeTokens / elapsed)
    }
  }
  state.phase = 'idle'
  state.promptTokenRate = state.peakPromptTokenRate
  state.generationTokenRate = state.peakGenerationTokenRate
  state.tokenRate = state.peakGenerationTokenRate
  state.confidence = Math.max(0, state.confidence * 0.6)
  state.updatedAt = Date.now()
  metrics = null
  resetRateWindows()
  bumpStreamListeners()
}

export function useAvatarStreamViz(): AvatarStreamViz {
  const [snap, setSnap] = useState(state)
  useEffect(() => {
    const refresh = (): void => setSnap({ ...state })
    const off = subscribeAvatarStreamViz(refresh)
    const id = setInterval(refresh, 180)
    return () => {
      off()
      clearInterval(id)
    }
  }, [])
  return snap
}

export function useAvatarInferenceMetrics(): InferenceMetricsSnapshot | null {
  const [snap, setSnap] = useState(metrics)
  useEffect(() => {
    const refresh = (): void => setSnap(metrics ? { ...metrics } : null)
    const off = subscribeAvatarStreamViz(refresh)
    const id = setInterval(refresh, 180)
    return () => {
      off()
      clearInterval(id)
    }
  }, [])
  return snap
}
