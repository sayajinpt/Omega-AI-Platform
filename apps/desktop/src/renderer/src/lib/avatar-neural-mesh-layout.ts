import * as THREE from 'three'
import { AVATAR_VIS_LAYERS } from '../../../shared/avatar-layout'
import type { CompanionAnimationStyle } from '../../../shared/companion-animation-style'
import type { CompanionColorPalette } from '../../../shared/companion-color-scheme'
import { getActiveCompanionColorPalette } from './companion-color-scheme'

export type NetNode = { layer: number; idx: number; pos: THREE.Vector3 }

export type NeuralMeshNetwork = { nodes: NetNode[]; edges: [number, number][] }

export type NeuralMeshSceneOpts = {
  nPerLayer: number
  nodeRadius: number
  pulseCount: number
  showLayerRings: boolean
  ringSegments: number
  rotation: { yawMul: number; yawAdd: number; pitchMul: number; rollMul?: number }
  lineOpacityBase: number
  ringColor: number
}

const layerZ = (L: number): number => -0.78 + (L / Math.max(1, AVATAR_VIS_LAYERS - 1)) * 1.56

function ni(nPerLayer: number, L: number, i: number): number {
  return L * nPerLayer + i
}

function linkLayers(
  edges: [number, number][],
  nPerLayer: number,
  L: number,
  fanout: number
): void {
  for (let i = 0; i < nPerLayer; i++) {
    for (let k = 0; k < fanout; k++) {
      const j = (i + k + L) % nPerLayer
      edges.push([ni(nPerLayer, L, i), ni(nPerLayer, L + 1, j)])
    }
  }
}

/** Default layered rings — original companion mesh. */
function buildClassicMesh(): NeuralMeshNetwork {
  const nPerLayer = 8
  const nodes: NetNode[] = []
  for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
    const z = layerZ(L)
    const radius = 0.28 + (L % 3) * 0.045
    for (let i = 0; i < nPerLayer; i++) {
      const angle = (i / nPerLayer) * Math.PI * 2 + L * 0.38
      nodes.push({
        layer: L,
        idx: i,
        pos: new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.88, z)
      })
    }
  }
  const edges: [number, number][] = []
  for (let L = 0; L < AVATAR_VIS_LAYERS - 1; L++) linkLayers(edges, nPerLayer, L, 2)
  return { nodes, edges }
}

export function buildNeuralMeshNetwork(_variant?: CompanionAnimationStyle): NeuralMeshNetwork {
  return buildClassicMesh()
}

export function getNeuralMeshSceneOpts(
  _variant?: CompanionAnimationStyle,
  palette: CompanionColorPalette = getActiveCompanionColorPalette()
): NeuralMeshSceneOpts {
  return {
    nPerLayer: 8,
    nodeRadius: 0.038,
    pulseCount: 14,
    showLayerRings: true,
    ringSegments: 32,
    rotation: { yawMul: 0.1, yawAdd: 0.28, pitchMul: 0.18 },
    lineOpacityBase: 0.3,
    ringColor: palette.ring
  }
}

/** Layer ring polyline — classic uses fixed ellipse; lattice/helix follow node positions. */
export function ringPointsForLayer(
  variant: CompanionAnimationStyle,
  L: number,
  net: NeuralMeshNetwork,
  segments: number
): THREE.Vector3[] {
  const layerNodes = net.nodes.filter((n) => n.layer === L)
  if (layerNodes.length === 0) {
    const z = layerZ(L)
    const radius = 0.34 + (L % 3) * 0.05
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * 0.88, z))
    }
    return pts
  }
  if (variant === 'neural_mesh') {
    const z = layerZ(L)
    const radius = 0.34 + (L % 3) * 0.05
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * 0.88, z))
    }
    return pts
  }
  const sorted = [...layerNodes].sort((a, b) => a.idx - b.idx)
  const pts: THREE.Vector3[] = sorted.map((n) => n.pos.clone())
  if (pts.length > 0) pts.push(pts[0]!.clone())
  return pts
}

export function maxPulsesForPhase(
  variant: CompanionAnimationStyle,
  phase: string,
  pulse: number
): number {
  const base = getNeuralMeshSceneOpts(variant).pulseCount
  if (phase === 'prefill') return base
  if (phase === 'decode') return Math.max(6, Math.floor(base * 0.72))
  if (pulse > 0.25) return Math.max(4, Math.floor(base * 0.38))
  return Math.max(2, Math.floor(base * 0.16))
}
