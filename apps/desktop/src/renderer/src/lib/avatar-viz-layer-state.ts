import * as THREE from 'three'
import { AVATAR_VIS_LAYERS } from '../../../shared/avatar-layout'
import type { CompanionColorPalette } from '../../../shared/companion-color-scheme'
import type { AvatarNeuralActivity } from './avatar-neural-activity'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import { getActiveCompanionColorPalette } from './companion-color-scheme'

function poolLayerBias(role: string, index: number, total: number): number {
  if (role === 'embedding') return 0.45
  if (role === 'secondary') return 0.12 + (index / Math.max(1, total)) * 0.25
  return 0.72 - (index / Math.max(1, total)) * 0.2
}

export type VizLayerFrame = {
  t: number
  pulse: number
  wavePos: number
  layerHot: number[]
  baseColor: THREE.Color
  gpuColor: THREE.Color
  cpuColor: THREE.Color
  hotColor: THREE.Color
  migFlash: number
}

export function createVizColors(palette = getActiveCompanionColorPalette()): {
  gpuColor: THREE.Color
  cpuColor: THREE.Color
  hotColor: THREE.Color
} {
  return {
    gpuColor: new THREE.Color(palette.gpu),
    cpuColor: new THREE.Color(palette.cpu),
    hotColor: new THREE.Color(palette.hot)
  }
}

export function applyPaletteToFrame(frame: VizLayerFrame, palette: CompanionColorPalette): void {
  frame.gpuColor.setHex(palette.gpu)
  frame.cpuColor.setHex(palette.cpu)
  frame.hotColor.setHex(palette.hot)
}

export function stepVizLayerFrame(
  frame: VizLayerFrame,
  signals: AvatarSignals,
  activity: AvatarNeuralActivity,
  dt = 0.016,
  palette = getActiveCompanionColorPalette()
): void {
  applyPaletteToFrame(frame, palette)
  frame.t += dt
  const active =
    activity.phase === 'prefill'
      ? 0.95
      : activity.phase === 'decode' || activity.phase === 'loading'
        ? 0.75
        : signals.state === 'thinking'
          ? 0.85
          : signals.state === 'speaking'
            ? signals.speaking
            : signals.state === 'error'
              ? 0.5
              : 0.12
  frame.pulse += (active - frame.pulse) * 0.08

  const speed = activity.waveSpeed * (activity.phase === 'prefill' ? 1.4 : 1)
  frame.wavePos = (frame.wavePos + speed * dt) % 1

  if (signals.state === 'error') frame.baseColor.setHex(palette.error)
  else if (activity.phase === 'prefill') frame.baseColor.setHex(palette.prefill)
  else if (activity.phase === 'decode' || signals.state === 'speaking')
    frame.baseColor.setHex(palette.active)
  else if (activity.phase === 'loading') frame.baseColor.setHex(palette.loading)
  else frame.baseColor.setHex(palette.idle)

  frame.migFlash = 0
  let migFrom = 0
  let migTo = 0
  if (activity.migration) {
    const age = (Date.now() - activity.migration.startedAt) / 1000
    if (age < 2.2) {
      frame.migFlash = 1 - age / 2.2
      migFrom = Math.floor(activity.migration.from * AVATAR_VIS_LAYERS)
      migTo = Math.floor(activity.migration.to * AVATAR_VIS_LAYERS)
    }
  }

  const poolLoaded = activity.pool.filter((p) => p.status === 'loaded' || p.status === 'preload')

  if (activity.phase === 'loading') {
    const fillLayer = Math.floor((activity.loadPercent / 100) * AVATAR_VIS_LAYERS)
    for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
      frame.layerHot[L] = L <= fillLayer ? 0.85 : 0.1
    }
  } else {
    const waveLayer = frame.wavePos * (AVATAR_VIS_LAYERS - 1)
    for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
      const dist = Math.abs(L - waveLayer)
      let hot = Math.max(0, 1 - dist / 1.8) * frame.pulse
      if (L < activity.gpuLayersVisual && (activity.phase === 'prefill' || activity.phase === 'decode')) {
        hot += 0.25
      }
      if (frame.migFlash > 0 && L >= Math.min(migFrom, migTo) && L <= Math.max(migFrom, migTo)) {
        hot += frame.migFlash * 0.9
      }
      frame.layerHot[L] = hot
    }
  }

  poolLoaded.forEach((slot, idx) => {
    const center = Math.floor(poolLayerBias(slot.role, idx, poolLoaded.length) * (AVATAR_VIS_LAYERS - 1))
    for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
      const d = Math.abs(L - center)
      frame.layerHot[L] = Math.min(1, frame.layerHot[L]! + Math.max(0, 0.55 - d * 0.22))
    }
  })
}

export function newVizLayerFrame(palette = getActiveCompanionColorPalette()): VizLayerFrame {
  const { gpuColor, cpuColor, hotColor } = createVizColors(palette)
  return {
    t: 0,
    pulse: 0,
    wavePos: 0,
    layerHot: new Array(AVATAR_VIS_LAYERS).fill(0),
    baseColor: new THREE.Color(palette.idle),
    gpuColor,
    cpuColor,
    hotColor,
    migFlash: 0
  }
}
