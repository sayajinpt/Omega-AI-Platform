import { engineClient } from '../lib/engine'
/**
 * Floating 3D brain avatar — layered neural viz driven by live inference state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three'
import { AVATAR_VIS_LAYERS } from '../../../shared/avatar-layout'
import { useAvatarNeuralActivity, type AvatarNeuralActivity } from '../lib/avatar-neural-activity'
import {
  AVATAR_SQUARE,
  AVATAR_SCALE_DEFAULT,
  avatarExpandedGridRows,
  avatarExpandedMetrics,
  avatarMonitorSize,
  avatarUiScale,
  clampAvatarScale
} from '../../../shared/avatar-layout'
import { getAvatarStreamViz } from '../lib/avatar-stream-viz'
import { setAvatarMonitorEnabled } from '../lib/avatar-monitor-prefs'
import { CompanionVizPanel } from './CompanionVizPanel'
import {
  formatContextTokensLabel,
  onContextTokens,
  type ContextTokensState
} from '../lib/context-tokens-bridge'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import { useAvatarResources } from './AvatarResourceHud'
import type { ScreenSnipCaptureResult } from '../../../shared/screen-snip-types'
import { stageSnipToMainChat } from '../lib/companion-snip'
import { CompanionQuickChat } from './CompanionQuickChat'
import { SnipResultBar } from './SnipResultBar'
import {
  getCompanionAnimationStyle,
  onCompanionAnimationStyle,
  type CompanionAnimationStyle
} from '../lib/companion-animation-style'
import {
  buildCompanionColorPalette,
  getActiveCompanionColorPalette,
  getCompanionCustomColors,
  onCompanionCustomColors,
  type CompanionCustomColors
} from '../lib/companion-color-scheme'
import type { CompanionColorPalette } from '../../../shared/companion-color-scheme'
import { CompanionAvatarView } from './CompanionAvatarView'
import {
  buildNeuralMeshNetwork,
  getNeuralMeshSceneOpts,
  maxPulsesForPhase,
  ringPointsForLayer
} from '../lib/avatar-neural-mesh-layout'
import { mountMatrixLayersScene } from '../lib/avatar-matrix-layers-scene'
import { mountSpiderWebScene } from '../lib/avatar-spider-web-scene'
import { isCompanionAnimationStyle } from '../lib/companion-animation-style'
import {
  clampPanelPos,
  viewportSize,
  useCompanionInteractionGuard,
  useCompanionPanelDrag,
  useCompanionPanelResize,
  type PanelPos
} from '../lib/companion-panel-interaction'

export type { AvatarSignals }

function poolLayerBias(role: string, index: number, total: number): number {
  if (role === 'embedding') return 0.45
  if (role === 'secondary') return 0.12 + (index / Math.max(1, total)) * 0.25
  return 0.72 - (index / Math.max(1, total)) * 0.2
}

const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  loading: 'Load weights',
  prefill: 'Attention · prefill',
  decode: 'Decode · KV',
  retrieval: 'Retrieval',
  tool: 'Tool I/O'
}

export function Avatar3D({
  signals,
  activity,
  meshVariant = 'neural_mesh',
  customColors,
  uiScale = 1,
  hideBottomBadges = false
}: {
  signals: AvatarSignals
  activity: AvatarNeuralActivity
  meshVariant?: CompanionAnimationStyle
  customColors: CompanionCustomColors
  /** Scales phase badges and layer labels with companion resize. */
  uiScale?: number
  /** Hide footer badges when companion chat overlay is used. */
  hideBottomBadges?: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const sigRef = useRef(signals)
  const actRef = useRef(activity)
  sigRef.current = signals
  actRef.current = activity

  useEffect(() => {
    const mount = mountRef.current
    const wrap = wrapRef.current
    if (!mount || !wrap) return

    const palette: CompanionColorPalette = buildCompanionColorPalette(customColors)

    if (meshVariant === 'matrix_layers') {
      return mountMatrixLayersScene({
        mount,
        wrap,
        sigRef,
        actRef,
        palette
      })
    }
    if (meshVariant === 'spider_web') {
      return mountSpiderWebScene({
        mount,
        wrap,
        sigRef,
        actRef,
        palette
      })
    }

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    camera.position.set(0, 0.1, 2.4)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const applySize = (): void => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (w < 8 || h < 8) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    applySize()
    const ro = new ResizeObserver(applySize)
    ro.observe(wrap)

    const opts = getNeuralMeshSceneOpts(meshVariant, palette)
    const net = buildNeuralMeshNetwork(meshVariant)
    const group = new THREE.Group()
    scene.add(group)

    const layerRings: THREE.Line[] = []
    if (opts.showLayerRings) {
      for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
        const pts = ringPointsForLayer(meshVariant, L, net, opts.ringSegments)
        const ringGeom = new THREE.BufferGeometry().setFromPoints(pts)
        const ring = new THREE.Line(
          ringGeom,
          new THREE.LineBasicMaterial({
            color: opts.ringColor,
            transparent: true,
            opacity: 0.18
          })
        )
        group.add(ring)
        layerRings.push(ring)
      }
    }

    const nodeGeom = new THREE.SphereGeometry(opts.nodeRadius, 8, 8)
    const nodeMeshes: THREE.Mesh[] = []
    for (const n of net.nodes) {
      const mat = new THREE.MeshStandardMaterial({
        color: palette.node,
        emissive: palette.nodeEmissive,
        metalness: 0.45,
        roughness: 0.32
      })
      const m = new THREE.Mesh(nodeGeom, mat)
      m.position.copy(n.pos)
      group.add(m)
      nodeMeshes.push(m)
    }

    const edgeCount = net.edges.length
    const linePositions = new Float32Array(edgeCount * 6)
    const lineColors = new Float32Array(edgeCount * 6)
    for (let e = 0; e < edgeCount; e++) {
      const [a, b] = net.edges[e]!
      const pa = net.nodes[a]!.pos
      const pb = net.nodes[b]!.pos
      const o = e * 6
      linePositions[o] = pa.x
      linePositions[o + 1] = pa.y
      linePositions[o + 2] = pa.z
      linePositions[o + 3] = pb.x
      linePositions[o + 4] = pb.y
      linePositions[o + 5] = pb.z
    }
    const lineGeom = new THREE.BufferGeometry()
    lineGeom.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
    lineGeom.setAttribute('color', new THREE.BufferAttribute(lineColors, 3))
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65
    })
    const lines = new THREE.LineSegments(lineGeom, lineMat)
    group.add(lines)

    const pulseGeom = new THREE.SphereGeometry(opts.nodeRadius * 0.58, 6, 6)
    const pulses: { mesh: THREE.Mesh; edge: number; t: number; speed: number }[] = []
    for (let i = 0; i < opts.pulseCount; i++) {
      const mesh = new THREE.Mesh(
        pulseGeom,
        new THREE.MeshBasicMaterial({ color: palette.pulse, transparent: true, opacity: 0.9 })
      )
      group.add(mesh)
      pulses.push({ mesh, edge: i % edgeCount, t: Math.random(), speed: 0.35 + Math.random() * 0.5 })
    }

    scene.add(new THREE.AmbientLight(palette.ambientLight, 0.5))
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.set(2, 2, 3)
    scene.add(key)
    const rim = new THREE.PointLight(palette.rimLight, 0.8, 8)
    rim.position.set(-1, 0, 2)
    scene.add(rim)

    let raf = 0
    let t = 0
    let pulse = 0
    let wavePos = 0
    const tmpColor = new THREE.Color()
    const gpuColor = new THREE.Color(palette.gpu)
    const cpuColor = new THREE.Color(palette.cpu)
    const hotColor = new THREE.Color(palette.hot)

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (document.hidden) return

      const livePalette = getActiveCompanionColorPalette()
      gpuColor.setHex(livePalette.gpu)
      cpuColor.setHex(livePalette.cpu)
      hotColor.setHex(livePalette.hot)
      t += 0.016
      const s = sigRef.current
      const a = actRef.current
      const active =
        a.phase === 'prefill'
          ? 0.95
          : a.phase === 'decode' || a.phase === 'loading'
            ? 0.75
            : s.state === 'thinking'
              ? 0.85
              : s.state === 'speaking'
                ? s.speaking
                : s.state === 'error'
                  ? 0.5
                  : a.phase === 'idle' && s.state === 'idle'
                    ? 0.04
                    : 0.12
      pulse += (active - pulse) * 0.08

      const speed = a.waveSpeed * (a.phase === 'prefill' ? 1.4 : 1)
      wavePos = (wavePos + speed * 0.016) % 1

      const baseColor =
        s.state === 'error'
          ? new THREE.Color(livePalette.error)
          : a.phase === 'prefill'
            ? new THREE.Color(livePalette.prefill)
            : a.phase === 'decode' || s.state === 'speaking'
              ? new THREE.Color(livePalette.active)
              : a.phase === 'loading'
                ? new THREE.Color(livePalette.loading)
                : new THREE.Color(livePalette.idle)

      let migFlash = 0
      let migFrom = 0
      let migTo = 0
      if (a.migration) {
        const age = (Date.now() - a.migration.startedAt) / 1000
        if (age < 2.2) {
          migFlash = 1 - age / 2.2
          migFrom = Math.floor(a.migration.from * AVATAR_VIS_LAYERS)
          migTo = Math.floor(a.migration.to * AVATAR_VIS_LAYERS)
        }
      }

      const poolLoaded = a.pool.filter((p) => p.status === 'loaded' || p.status === 'preload')
      const layerHot = new Array(AVATAR_VIS_LAYERS).fill(0) as number[]

      if (a.phase === 'loading') {
        const fillLayer = Math.floor((a.loadPercent / 100) * AVATAR_VIS_LAYERS)
        for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
          layerHot[L] = L <= fillLayer ? 0.85 : 0.1
        }
      } else {
        const waveLayer = wavePos * (AVATAR_VIS_LAYERS - 1)
        for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
          const dist = Math.abs(L - waveLayer)
          let hot = Math.max(0, 1 - dist / 1.8) * pulse
          if (L < a.gpuLayersVisual && (a.phase === 'prefill' || a.phase === 'decode')) hot += 0.25
          if (migFlash > 0 && L >= Math.min(migFrom, migTo) && L <= Math.max(migFrom, migTo)) {
            hot += migFlash * 0.9
          }
          layerHot[L] = hot
        }
      }

      poolLoaded.forEach((slot, idx) => {
        const center = Math.floor(poolLayerBias(slot.role, idx, poolLoaded.length) * (AVATAR_VIS_LAYERS - 1))
        for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
          const d = Math.abs(L - center)
          layerHot[L] = Math.min(1, layerHot[L]! + Math.max(0, 0.55 - d * 0.22))
        }
      })

      group.rotation.y = Math.sin(t * opts.rotation.yawAdd) * 0.22 + t * opts.rotation.yawMul
      group.rotation.x = Math.sin(t * opts.rotation.pitchMul) * 0.06
      if (opts.rotation.rollMul) {
        group.rotation.z = Math.sin(t * opts.rotation.rollMul) * 0.08
      }
      const breathe = 1 + Math.sin(t * 1.2) * 0.03 + pulse * 0.08
      group.scale.setScalar(breathe)

      lineMat.opacity = opts.lineOpacityBase + pulse * 0.55

      for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
        const ring = layerRings[L]!
        const mat = ring.material as THREE.LineBasicMaterial
        const onGpu = L < a.gpuLayersVisual
        mat.color.copy(onGpu ? gpuColor : cpuColor)
        mat.opacity = 0.12 + layerHot[L]! * 0.55
      }

      const stream = getAvatarStreamViz()
      const streamSeed = stream.decodeTokens + Math.floor(t * 2)

      for (let i = 0; i < nodeMeshes.length; i++) {
        const n = net.nodes[i]!
        const m = nodeMeshes[i]!
        const mat = m.material as THREE.MeshStandardMaterial
        const onGpu = n.layer < a.gpuLayersVisual
        const hot = layerHot[n.layer] ?? 0
        const gate = ((n.layer * 17 + n.idx * 31 + streamSeed) % 100) / 100
        const sparseActive = hot > 0.28 && gate < 0.14 + hot * 0.22
        tmpColor.copy(onGpu ? gpuColor : cpuColor)
        if (sparseActive) tmpColor.lerp(hotColor, (hot - 0.35) * 1.2)
        tmpColor.lerp(baseColor, 0.15)
        mat.color.lerp(tmpColor, 0.12)
        mat.emissive.lerp(
          tmpColor.clone().multiplyScalar(sparseActive ? 0.4 + hot * 0.35 : 0.12),
          0.12
        )
        const vramW = a.layerVramWeight[n.layer] ?? 0.35
        const flicker = sparseActive
          ? (0.75 + vramW * 0.45 + hot * 0.55 + Math.sin(t * 5 + n.layer * 0.9 + n.idx * 0.4) * hot * 0.2) *
            (onGpu ? 1 : 0.82)
          : 0.32 + hot * 0.2
        m.scale.setScalar(flicker)
      }

      for (let e = 0; e < edgeCount; e++) {
        const [ai, bi] = net.edges[e]!
        const la = net.nodes[ai]!.layer
        const lb = net.nodes[bi]!.layer
        const hot = (layerHot[la]! + layerHot[lb]!) * 0.5
        const onGpu = la < a.gpuLayersVisual && lb < a.gpuLayersVisual
        tmpColor.copy(onGpu ? gpuColor : cpuColor)
        if (hot > 0.3) tmpColor.lerp(hotColor, hot * 0.5)
        const o = e * 6
        lineColors[o] = tmpColor.r
        lineColors[o + 1] = tmpColor.g
        lineColors[o + 2] = tmpColor.b
        lineColors[o + 3] = tmpColor.r
        lineColors[o + 4] = tmpColor.g
        lineColors[o + 5] = tmpColor.b
      }
      lineGeom.attributes.color!.needsUpdate = true

      const maxPulses = maxPulsesForPhase(meshVariant, a.phase, pulse)
      for (let pi = 0; pi < pulses.length; pi++) {
        const p = pulses[pi]!
        const active = pi < maxPulses
        p.mesh.visible = active
        if (!active) continue
        p.t += p.speed * 0.016 * (0.5 + pulse)
        if (p.t > 1) {
          p.t -= 1
          if (a.phase === 'prefill') {
            const layer = Math.floor(wavePos * (AVATAR_VIS_LAYERS - 1))
            p.edge = Math.min(edgeCount - 1, layer * opts.nPerLayer + (pi % opts.nPerLayer))
          } else {
            p.edge = Math.floor(Math.random() * edgeCount)
          }
        }
        const [ai, bi] = net.edges[p.edge]!
        const pa = net.nodes[ai]!.pos
        const pb = net.nodes[bi]!.pos
        p.mesh.position.lerpVectors(pa, pb, p.t)
        const mat = p.mesh.material as THREE.MeshBasicMaterial
        mat.opacity = 0.25 + pulse * 0.75
        mat.color.copy(baseColor)
      }

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      renderer.dispose()
      nodeGeom.dispose()
      pulseGeom.dispose()
      lineGeom.dispose()
      layerRings.forEach((r) => {
        r.geometry.dispose()
        ;(r.material as THREE.Material).dispose()
      })
      nodeMeshes.forEach((m) => {
        ;(m.material as THREE.Material).dispose()
      })
      pulses.forEach((p) => {
        ;(p.mesh.material as THREE.Material).dispose()
      })
      lineMat.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [meshVariant, customColors])

  const badgePx = Math.max(7, Math.round(8 * uiScale))
  const layerLabelPx = Math.max(6, Math.round(7 * uiScale))
  const phaseLabel = PHASE_LABELS[activity.phase] ?? activity.phase
  const gpuLabel =
    activity.gpuLayersVisual >= AVATAR_VIS_LAYERS
      ? 'all GPU'
      : activity.gpuLayersVisual > 0
        ? `L0–L${Math.min(activity.totalLayers - 1, activity.layerIndices[activity.gpuLayersVisual - 1] ?? 0)} GPU`
        : 'CPU'
  const layersLabel =
    activity.activeModel && activity.totalLayers > 0 ? `${activity.totalLayers} layers` : null

  return (
    <div ref={wrapRef} className="relative mx-auto h-full w-full min-h-0">
      <div
        ref={mountRef}
        className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-indigo-950/40 to-zinc-950/60 ring-1 ring-indigo-500/20"
        aria-hidden
      />
      {activity.totalLayers > 0 && (
        <div
          className="pointer-events-none absolute left-0.5 top-2 z-10 flex flex-col justify-between py-1"
          style={{ bottom: Math.round(32 * uiScale) }}
          aria-hidden
        >
          {activity.layerIndices.map((idx, v) => (
            <span
              key={v}
              className={`font-medium tabular-nums leading-none ${
                v < activity.gpuLayersVisual ? 'text-cyan-400/90' : 'text-indigo-400/50'
              }`}
              style={{ fontSize: layerLabelPx }}
              title={`Model layer ~${idx}${activity.perLayerMb ? ` · ~${activity.perLayerMb} MB/layer` : ''}`}
            >
              L{idx}
            </span>
          ))}
        </div>
      )}
      {!hideBottomBadges && (
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex flex-wrap justify-center gap-1 px-1">
        <span
          className="rounded bg-zinc-950/80 font-medium text-cyan-300/90 ring-1 ring-cyan-500/25"
          style={{ fontSize: badgePx, padding: `${Math.max(1, Math.round(2 * uiScale))}px ${Math.max(4, Math.round(6 * uiScale))}px` }}
        >
          {phaseLabel}
        </span>
        <span
          className="rounded bg-zinc-950/80 text-indigo-300/80 ring-1 ring-indigo-500/20"
          style={{ fontSize: badgePx, padding: `${Math.max(1, Math.round(2 * uiScale))}px ${Math.max(4, Math.round(6 * uiScale))}px` }}
        >
          {gpuLabel}
        </span>
        {layersLabel && (
          <span
            className="rounded bg-zinc-950/80 text-zinc-400 ring-1 ring-zinc-600/30"
            style={{ fontSize: badgePx, padding: `${Math.max(1, Math.round(2 * uiScale))}px ${Math.max(4, Math.round(6 * uiScale))}px` }}
          >
            {layersLabel}
          </span>
        )}
        {activity.phase === 'loading' && (
          <span
            className="rounded bg-zinc-950/80 tabular-nums text-violet-300/90"
            style={{ fontSize: badgePx, padding: `${Math.max(1, Math.round(2 * uiScale))}px ${Math.max(4, Math.round(6 * uiScale))}px` }}
          >
            {Math.round(activity.loadPercent)}%
          </span>
        )}
      </div>
      )}
    </div>
  )
}

const STORAGE_KEY = 'omega.avatar.pos'
const SCALE_KEY = 'omega.avatar.scale'

function loadScale(): number {
  try {
    const n = Number(localStorage.getItem(SCALE_KEY))
    if (Number.isFinite(n)) return clampAvatarScale(n)
  } catch {
    /* ignore */
  }
  return AVATAR_SCALE_DEFAULT
}

const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

function ResizeCorner({
  onPointerDown,
  chatOpen
}: {
  onPointerDown: (e: React.PointerEvent) => void
  chatOpen?: boolean
}) {
  return (
    <button
      type="button"
      aria-label="Resize panel"
      onPointerDown={onPointerDown}
      style={{ ...noDrag, touchAction: 'none' }}
      className={`absolute right-0 z-40 flex h-8 w-8 cursor-se-resize items-end justify-end rounded-br-xl p-1 text-zinc-500 hover:bg-zinc-800/80 hover:text-cyan-300 ${
        chatOpen ? 'top-9' : 'bottom-0'
      }`}
      title="Drag corner to resize"
    >
      <svg viewBox="0 0 12 12" className="h-3.5 w-3.5 opacity-80" aria-hidden>
        <path d="M12 12H7v-2h2V8h2v2h1V7h2v5z" fill="currentColor" />
      </svg>
    </button>
  )
}

function MonitorToggle({
  enabled,
  overlay,
  onChange
}: {
  enabled: boolean
  overlay?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label
      className="flex cursor-pointer items-center gap-1 rounded px-1 hover:bg-zinc-800"
      style={noDrag}
      title={
        overlay
          ? 'Attach back to Omega window'
          : 'Detach to desktop — stays visible when Omega is minimized'
      }
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-2.5 w-2.5 accent-cyan-500"
      />
      <span className={enabled ? 'text-cyan-300' : ''}>Detach</span>
    </label>
  )
}

function loadPos(panelW: number, panelH: number): PanelPos {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as PanelPos
      return clampPanelPos(p, panelW, panelH)
    }
  } catch {
    /* ignore */
  }
  const { w, h } = viewportSize()
  return clampPanelPos({ x: w - panelW - 16, y: h - panelH - 16 }, panelW, panelH)
}

const COMPANION_CHAT_KEY = 'omega.companion.chatOpen'

const STATE_LABELS: Record<AvatarSignals['state'], string> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  speaking: 'Generating',
  error: 'Error'
}

export function FloatingAvatar({
  signals,
  overlay = false,
  monitorEnabled = false,
  onMonitorToggle,
  onRequestHide
}: {
  signals: AvatarSignals
  /** Desktop overlay window (always on top, survives main window minimize). */
  overlay?: boolean
  monitorEnabled?: boolean
  onMonitorToggle?: (enabled: boolean) => void
  onRequestHide?: () => void
}) {
  const [scale, setScale] = useState(loadScale)
  const [animStyle, setAnimStyle] = useState<CompanionAnimationStyle>(() => getCompanionAnimationStyle())
  const [customColors, setCustomColors] = useState<CompanionCustomColors>(() =>
    getCompanionCustomColors()
  )
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem(COMPANION_CHAT_KEY) === '1')
  const [snipActive, setSnipActive] = useState(false)
  const [snipResult, setSnipResult] = useState<ScreenSnipCaptureResult | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const overlayPosRef = useRef({ x: 0, y: 0 })
  const resources = useAvatarResources(2500)
  const neural = useAvatarNeuralActivity(signals, resources)
  const [ctxTokens, setCtxTokens] = useState<ContextTokensState>(() => ({
    sessionId: null,
    tokenEstimate: 0,
    maxContext: 0,
    messageCount: 0
  }))

  useEffect(() => onContextTokens(setCtxTokens), [])
  useEffect(() => onCompanionAnimationStyle(setAnimStyle), [])
  useEffect(() => {
    return onCompanionCustomColors(setCustomColors)
  }, [])

  const panelSize = avatarMonitorSize(false, scale)
  const panelW = panelSize.width
  const panelH = panelSize.height
  const uiScale = avatarUiScale(scale)
  const headerFontPx = Math.max(9, Math.round(10 * uiScale))
  const [pos, setPos] = useState<PanelPos>(() => loadPos(panelW, panelH))

  const measurePanel = useCallback((): { w: number; h: number } => {
    const el = panelRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { w: rect.width, h: rect.height }
      }
    }
    return { w: panelW, h: panelH }
  }, [panelW, panelH])

  const syncOverlayLayout = useCallback(
    (nextScale: number, screenPos?: { x: number; y: number }): void => {
      if (!overlay) return
      engineClient.avatarMonitor.syncLayout({
        collapsed: false,
        scale: nextScale,
        ...(screenPos ?? { x: overlayPosRef.current.x, y: overlayPosRef.current.y })
      })
    },
    [overlay]
  )

  const persistScale = useCallback(
    (next: number): void => {
      const c = clampAvatarScale(next)
      setScale(c)
      try {
        localStorage.setItem(SCALE_KEY, String(c))
      } catch {
        /* ignore */
      }
      syncOverlayLayout(c)
    },
    [syncOverlayLayout]
  )

  const { modeRef, clampToViewport, finishInteraction } = useCompanionInteractionGuard(
    overlay,
    panelW,
    panelH,
    scale,
    pos,
    setPos,
    measurePanel
  )

  const onHeaderPointerDown = useCompanionPanelDrag({
    overlay,
    pos,
    setPos,
    scale,
    modeRef,
    clampToViewport,
    finishInteraction,
    syncOverlayLayout,
    overlayPosRef
  })

  const onResizePointerDown = useCompanionPanelResize({
    overlay,
    scale,
    setScale,
    persistScale,
    modeRef,
    finishInteraction,
    syncOverlayLayout: (next) => syncOverlayLayout(next)
  })

  const setChatOpenAndPersist = useCallback((open: boolean): void => {
    setChatOpen(open)
    try {
      localStorage.setItem(COMPANION_CHAT_KEY, open ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const startScreenSnip = useCallback(async (): Promise<void> => {
    if (snipActive) return
    setSnipActive(true)
    try {
      const result = await engineClient.screenSnip.capture()
      if (result) {
        setSnipResult(result)
        setChatOpenAndPersist(true)
      }
    } catch {
      /* ignore */
    } finally {
      setSnipActive(false)
    }
  }, [snipActive, setChatOpenAndPersist])

  const chatToggleBtn = (
    <button
      type="button"
      onClick={() => setChatOpenAndPersist(!chatOpen)}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={`rounded px-1 ${
        chatOpen ? 'bg-indigo-600/40 text-indigo-200' : 'hover:bg-zinc-800 hover:text-indigo-300'
      }`}
      title="Message current chat"
      style={noDrag}
    >
      💬
    </button>
  )

  const snipToggleBtn = (
    <button
      type="button"
      onClick={() => void startScreenSnip()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={`rounded px-1 ${
        snipActive ? 'bg-cyan-600/40 text-cyan-200' : 'hover:bg-zinc-800 hover:text-cyan-300'
      }`}
      title="Screen capture — drag a region (PrintScreen-style)"
      style={noDrag}
    >
      ⧉
    </button>
  )

  useEffect(() => {
    if (!overlay) return
    const off = engineClient.avatarMonitor.onLayout((layout) => {
      overlayPosRef.current = { x: layout.x, y: layout.y }
      if (layout.scale !== undefined) {
        setScale(clampAvatarScale(layout.scale))
        localStorage.setItem(SCALE_KEY, String(clampAvatarScale(layout.scale)))
      }
      const style = (layout as { animationStyle?: CompanionAnimationStyle }).animationStyle
      if (isCompanionAnimationStyle(style)) {
        setAnimStyle(style)
      }
    })
    return off
  }, [overlay])

  const handleDetachToggle = useCallback(
    async (on: boolean): Promise<void> => {
      if (overlay) {
        if (!on) {
          await setAvatarMonitorEnabled(false)
          onMonitorToggle?.(false)
        }
        return
      }
      if (on) {
        const el = panelRef.current
        const r = el?.getBoundingClientRect()
        const anchor = r
          ? { screenX: window.screenX + r.left, screenY: window.screenY + r.top }
          : undefined
        await setAvatarMonitorEnabled(true, anchor)
        engineClient.avatarMonitor.syncLayout({ collapsed: false, scale, animationStyle: animStyle })
      } else {
        await setAvatarMonitorEnabled(false)
      }
      onMonitorToggle?.(on)
    },
    [overlay, onMonitorToggle, animStyle, scale]
  )

  useEffect(() => {
    if (overlay || modeRef.current !== 'none') return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pos))
    } catch {
      /* ignore */
    }
  }, [pos, overlay, modeRef])

  const stateRing =
    signals.state === 'error'
      ? 'ring-rose-500/60 shadow-rose-500/20'
      : signals.state === 'thinking'
        ? 'ring-amber-400/60 shadow-amber-400/25 animate-pulse'
        : signals.state === 'speaking'
          ? 'ring-cyan-400/50 shadow-cyan-400/20'
          : 'ring-indigo-500/30'

  const rootPositionClass = overlay
    ? 'relative h-full w-full overflow-visible'
    : 'fixed z-[75] overflow-visible'
  const expandedPanelShell = `relative flex h-full w-full flex-col select-none overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950/90 shadow-2xl backdrop-blur-md ring-2 ${stateRing}`
  const panelBoxStyle: CSSProperties = overlay
    ? { boxSizing: 'border-box', width: '100%', height: '100%' }
    : {
        boxSizing: 'border-box',
        width: panelW,
        height: panelH,
        left: pos.x,
        top: pos.y
      }

  return (
    <div ref={panelRef} className={`${rootPositionClass} select-none`} style={panelBoxStyle}>
      <div
        className={expandedPanelShell}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateRows: avatarExpandedGridRows(scale)
        }}
      >
        <div
          onPointerDown={onHeaderPointerDown}
          className="flex shrink-0 cursor-grab items-center justify-between gap-1 rounded-t-2xl border-b border-zinc-800/80 bg-zinc-900/80 px-2 py-1 text-zinc-400 active:cursor-grabbing"
          style={{ fontSize: headerFontPx, touchAction: 'none' }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
            <span className="truncate text-zinc-500">{STATE_LABELS[signals.state]}</span>
            {ctxTokens.sessionId && ctxTokens.maxContext > 0 && (
              <span
                className="shrink-0 tabular-nums text-zinc-500"
                title={`Context: ${formatContextTokensLabel(ctxTokens)} tokens`}
              >
                · {formatContextTokensLabel(ctxTokens)}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-0.5" style={noDrag}>
            {onMonitorToggle && (
              <MonitorToggle
                enabled={overlay || monitorEnabled}
                overlay={overlay}
                onChange={(on) => void handleDetachToggle(on)}
              />
            )}
            {overlay && (
              <>
                <button
                  type="button"
                  onClick={() => void engineClient.avatarMonitor.restoreMain()}
                  className="rounded px-1 hover:bg-zinc-800 hover:text-cyan-300"
                  title="Restore Omega window"
                  style={noDrag}
                >
                  Ω
                </button>
                <button
                  type="button"
                  onClick={() => void handleDetachToggle(false)}
                  className="rounded px-1 hover:bg-zinc-800 hover:text-zinc-300"
                  title="Attach back to Omega window"
                  style={noDrag}
                >
                  ⊕
                </button>
              </>
            )}
            {snipToggleBtn}
            {chatToggleBtn}
            {!overlay && onRequestHide && (
              <button
                type="button"
                onClick={() => onRequestHide()}
                className="rounded px-1 hover:bg-zinc-800"
                title="Hide companion (re-enable in Settings → General)"
              >
                ×
              </button>
            )}
          </span>
        </div>
        <div className="relative min-h-0 overflow-hidden p-1">
          <div className="absolute inset-1 z-0 min-h-0 overflow-hidden rounded-xl">
            <CompanionAvatarView
              style={animStyle}
              customColors={customColors}
              signals={signals}
              activity={neural}
              uiScale={uiScale}
              hideBottomBadges={chatOpen}
            />
          </div>
          <div className="pointer-events-none absolute inset-x-1 top-1 z-10">
            <CompanionVizPanel activity={neural} uiScale={uiScale} compact />
          </div>
          {snipResult && (
            <div className="pointer-events-auto absolute inset-x-1 top-8 z-20">
              <SnipResultBar
                capture={snipResult}
                uiScale={uiScale}
                onSave={() => {
                  void engineClient.screenSnip.save(snipResult.tempPath).then(() => setSnipResult(null))
                }}
                onSend={() => {
                  void (async () => {
                    try {
                      await stageSnipToMainChat(snipResult)
                    } catch (e) {
                      console.error(e)
                    } finally {
                      setSnipResult(null)
                    }
                  })()
                }}
                onDismiss={() => setSnipResult(null)}
              />
            </div>
          )}
          {chatOpen && (
            <div className="pointer-events-auto absolute inset-x-1 bottom-1 z-20">
              <CompanionQuickChat uiScale={uiScale} onClose={() => setChatOpenAndPersist(false)} />
            </div>
          )}
        </div>
        <ResizeCorner onPointerDown={onResizePointerDown} chatOpen={chatOpen} />
      </div>
    </div>
  )
}
