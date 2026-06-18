import { useEffect, useRef, useState } from 'react'
import type { InferencePhase } from '@omega/sdk'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import { effectiveAvatarSignalState } from '../lib/avatar-stream-viz'
import type { AvatarResourceSnapshot } from '../components/AvatarResourceHud'
import { AVATAR_VIS_LAYERS } from '../../../shared/avatar-layout'
import { engineClient } from './engine'

export { AVATAR_VIS_LAYERS }

export type AvatarNeuralActivity = {
  state: AvatarSignals['state']
  phase: InferencePhase | 'loading' | 'idle'
  speaking: number
  gpuLayersVisual: number
  totalGpuLayers: number
  /** Block count from GGUF inspect (when model is loaded). */
  totalLayers: number
  /** Model layer index at the center of each visual band (length 8). */
  layerIndices: number[]
  /** Relative VRAM weight per visual band 0–1 (for dot/node size). */
  layerVramWeight: number[]
  perLayerMb: number
  loadPercent: number
  loadPhase?: string
  activeModel?: string
  pool: Array<{ modelId: string; role: string; device: string; status: string }>
  waveSpeed: number
  migration?: { from: number; to: number; startedAt: number }
}

const defaultActivity = (): AvatarNeuralActivity => ({
  state: 'idle',
  phase: 'idle',
  speaking: 0,
  gpuLayersVisual: 4,
  totalGpuLayers: 35,
  totalLayers: 32,
  layerIndices: defaultLayerIndices(32),
  layerVramWeight: defaultVramWeights(32, 16),
  perLayerMb: 0,
  loadPercent: 0,
  pool: [],
  waveSpeed: 0.35
})

function defaultLayerIndices(totalLayers: number): number[] {
  return Array.from({ length: AVATAR_VIS_LAYERS }, (_, v) =>
    Math.min(Math.max(0, totalLayers - 1), Math.floor(((v + 0.5) / AVATAR_VIS_LAYERS) * totalLayers))
  )
}

function defaultVramWeights(totalLayers: number, gpuLayers: number): number[] {
  return computeLayerVramWeights(totalLayers, gpuLayers)
}

function mapGpuLayersToVisual(gpuLayers: number, totalLayers: number): number {
  if (gpuLayers >= 999) return AVATAR_VIS_LAYERS
  if (gpuLayers <= 0) return 0
  const ratio = gpuLayers / Math.max(1, totalLayers + 1)
  return Math.min(AVATAR_VIS_LAYERS, Math.max(1, Math.round(ratio * AVATAR_VIS_LAYERS)))
}

function mapModelLayersToVisual(layer: number, totalLayers: number): number {
  return Math.min(1, Math.max(0, layer / Math.max(1, totalLayers)))
}

/** Per visual band: share of layers in that band that sit on GPU (0–1), scaled by band width. */
export function computeLayerVramWeights(totalLayers: number, gpuLayers: number): number[] {
  const weights: number[] = []
  for (let v = 0; v < AVATAR_VIS_LAYERS; v++) {
    const start = Math.floor((v / AVATAR_VIS_LAYERS) * totalLayers)
    const end = Math.floor(((v + 1) / AVATAR_VIS_LAYERS) * totalLayers)
    const count = Math.max(1, end - start)
    let onGpu = 0
    for (let l = start; l < end; l++) {
      if (l < gpuLayers) onGpu++
    }
    weights.push((onGpu / count) * (count / Math.max(1, totalLayers)))
  }
  const max = Math.max(...weights, 0.001)
  return weights.map((w) => w / max)
}

export function useAvatarNeuralActivity(
  signals: AvatarSignals,
  resources: AvatarResourceSnapshot | null
): AvatarNeuralActivity {
  const [activity, setActivity] = useState<AvatarNeuralActivity>(defaultActivity)
  const metaRef = useRef({ totalLayers: 32, gpuLayers: 16 })

  useEffect(() => {
    const off = engineClient.models.onLoadProgress((p) => {
      setActivity((prev) => ({
        ...prev,
        phase: 'loading',
        loadPercent: p.percent ?? prev.loadPercent,
        loadPhase: p.phase,
        activeModel: p.modelId,
        waveSpeed: 1.2
      }))
      if (p.phase === 'ready') {
        setActivity((prev) => ({
          ...prev,
          phase: 'idle',
          loadPercent: 100,
          waveSpeed: 0.35
        }))
      }
    })
    return off
  }, [])

  useEffect(() => {
    const runtime = resources?.runtime
    const totalLayers = metaRef.current.totalLayers
    const signalState = effectiveAvatarSignalState(signals.state)

    const migration = undefined as AvatarNeuralActivity['migration']

    setActivity((prev) => {
      let phase: AvatarNeuralActivity['phase'] = 'idle'
      if (prev.phase === 'loading') {
        phase = 'loading'
      } else if (signalState === 'thinking') {
        phase = 'prefill'
      } else if (signalState === 'speaking') {
        phase = 'decode'
      } else if (signalState === 'idle') {
        phase = 'idle'
      }

      return {
        ...prev,
        state: signalState,
        speaking: signalState === 'speaking' ? signals.speaking : 0,
        phase: signals.state === 'error' ? 'idle' : phase,
        activeModel: runtime?.activeModel,
        pool: [],
        migration: migration ?? prev.migration,
        waveSpeed:
          signalState === 'thinking'
            ? 1.8
            : signalState === 'speaking'
              ? 1.1
              : phase === 'prefill'
                ? 2.4
                : phase === 'decode'
                  ? 0.9
                  : phase === 'loading'
                    ? 1.2
                    : 0.35
      }
    })
  }, [signals, resources])

  useEffect(() => {
    const modelId = resources?.runtime?.activeModel
    if (!modelId) return

    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const [cfg, meta] = await Promise.all([
          engineClient.modelConfig.get(modelId),
          engineClient.modelMeta.inspect(modelId).catch(() => null)
        ])
        if (cancelled) return

        const totalLayers = meta?.totalLayers ?? 32
        const gl = cfg.gpuLayers ?? 0
        const gpuCount = gl >= 999 ? totalLayers + 1 : gl
        metaRef.current = { totalLayers, gpuLayers: gpuCount }

        let perLayerMb = 0
        let layerVramWeight = computeLayerVramWeights(totalLayers, gpuCount)
        try {
          const est = await engineClient.modelMeta.estimate(modelId, cfg)
          perLayerMb = est.perLayerMb
          if (est.perLayerMb > 0) {
            layerVramWeight = computeLayerVramWeights(totalLayers, gpuCount).map(
              (w, v) => w * (est.perLayerMb ?? 1)
            )
            const max = Math.max(...layerVramWeight, 0.001)
            layerVramWeight = layerVramWeight.map((w) => w / max)
          }
        } catch {
          /* keep geometric weights */
        }

        setActivity((prev) => ({
          ...prev,
          gpuLayersVisual: mapGpuLayersToVisual(gl, totalLayers),
          totalGpuLayers: gl >= 999 ? totalLayers + 1 : gl,
          totalLayers,
          layerIndices: defaultLayerIndices(totalLayers),
          layerVramWeight,
          perLayerMb
        }))
      } catch {
        if (cancelled) return
        const cfg = await engineClient.modelConfig.get(modelId)
        const gl = cfg.gpuLayers ?? 0
        setActivity((prev) => ({
          ...prev,
          gpuLayersVisual: mapGpuLayersToVisual(gl, prev.totalLayers),
          totalGpuLayers: gl >= 999 ? prev.totalLayers + 1 : gl
        }))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [resources?.runtime?.activeModel])

  return activity
}

export function layerDotIntensity(layer: number, act: AvatarNeuralActivity): number {
  const onGpu = layer < act.gpuLayersVisual
  if (act.phase === 'loading') {
    const fill = act.loadPercent / 100
    return onGpu ? 0.35 + fill * 0.65 : fill * 0.25
  }
  if (act.phase === 'prefill') return onGpu ? 0.95 : 0.25
  if (act.phase === 'decode') return onGpu ? 0.75 : 0.2
  if (act.phase === 'retrieval' || act.phase === 'tool') return 0.55 + layer * 0.04
  if (act.state === 'thinking') return onGpu ? 0.7 : 0.35
  if (act.state === 'speaking') return onGpu ? 0.85 : 0.4
  return onGpu ? 0.45 : 0.15
}

/** Collapsed mini-dot diameter in px from VRAM band weight + activity. */
export function layerDotSize(
  visualLayer: number,
  act: AvatarNeuralActivity,
  uiScale = 1
): number {
  const vram = act.layerVramWeight[visualLayer] ?? 0.35
  const hot = layerDotIntensity(visualLayer, act)
  return (3 + vram * 4.5 + hot * 2) * uiScale
}
