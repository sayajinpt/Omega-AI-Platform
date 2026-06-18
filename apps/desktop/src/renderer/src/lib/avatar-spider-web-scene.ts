/**
 * Companion viz: radial spider web — central hub, spokes, ring chords, leg nodes.
 */
import * as THREE from 'three'
import type { RefObject } from 'react'
import { AVATAR_VIS_LAYERS } from '../../../shared/avatar-layout'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import type { AvatarNeuralActivity } from './avatar-neural-activity'
import { getAvatarStreamViz } from './avatar-stream-viz'
import type { CompanionColorPalette } from '../../../shared/companion-color-scheme'
import { newVizLayerFrame, stepVizLayerFrame } from './avatar-viz-layer-state'

const SPOKES = 14
const RING_R = 0.82
const LEG_R = 1.05

export function mountSpiderWebScene(ctx: {
  mount: HTMLDivElement
  wrap: HTMLDivElement
  sigRef: RefObject<AvatarSignals>
  actRef: RefObject<AvatarNeuralActivity>
  palette: CompanionColorPalette
}): () => void {
  const { mount, wrap, sigRef, actRef, palette } = ctx
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100)
  camera.position.set(0, 0.05, 2.35)

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

  const group = new THREE.Group()
  scene.add(group)

  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 16),
    new THREE.MeshStandardMaterial({
      color: palette.spiderHub,
      emissive: palette.spiderHubEmissive,
      metalness: 0.5,
      roughness: 0.35
    })
  )
  group.add(hub)

  const outerNodes: THREE.Mesh[] = []
  const legNodes: THREE.Mesh[] = []
  const outerGeom = new THREE.SphereGeometry(0.038, 8, 8)
  const legGeom = new THREE.SphereGeometry(0.026, 6, 6)

  const outerPos: THREE.Vector3[] = []
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * Math.PI * 2 - Math.PI / 2
    const p = new THREE.Vector3(Math.cos(a) * RING_R, Math.sin(a) * RING_R * 0.9, 0.02 * Math.sin(i * 1.3))
    outerPos.push(p)
    const mat = new THREE.MeshStandardMaterial({
      color: palette.spiderOuter,
      emissive: palette.spiderOuterEmissive,
      metalness: 0.45,
      roughness: 0.32
    })
    const m = new THREE.Mesh(outerGeom, mat)
    m.position.copy(p)
    group.add(m)
    outerNodes.push(m)
  }

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2
    const p = new THREE.Vector3(Math.cos(a) * LEG_R, Math.sin(a) * LEG_R * 0.92, -0.03)
    const mat = new THREE.MeshStandardMaterial({
      color: palette.spiderLeg,
      emissive: palette.spiderLegEmissive,
      metalness: 0.4,
      roughness: 0.45
    })
    const m = new THREE.Mesh(legGeom, mat)
    m.position.copy(p)
    group.add(m)
    legNodes.push(m)
  }

  const linePts: number[] = []
  const hubV = new THREE.Vector3(0, 0, 0)
  for (let i = 0; i < SPOKES; i++) {
    const p = outerPos[i]!
    linePts.push(hubV.x, hubV.y, hubV.z, p.x, p.y, p.z)
    const j = (i + 2) % SPOKES
    const k = (i + 5) % SPOKES
    const pj = outerPos[j]!
    const pk = outerPos[k]!
    linePts.push(p.x, p.y, p.z, pj.x, pj.y, pj.z)
    if (i % 2 === 0) linePts.push(p.x, p.y, p.z, pk.x, pk.y, pk.z)
  }
  for (let i = 0; i < SPOKES; i++) {
    const a = outerPos[i]!
    const b = outerPos[(i + 1) % SPOKES]!
    linePts.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  for (let i = 0; i < 8; i++) {
    const leg = legNodes[i]!.position
    linePts.push(hubV.x, hubV.y, hubV.z, leg.x, leg.y, leg.z)
  }

  const lineGeom = new THREE.BufferGeometry()
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3))
  const lineColors = new Float32Array((linePts.length / 3) * 3)
  lineGeom.setAttribute('color', new THREE.BufferAttribute(lineColors, 3))
  const webLines = new THREE.LineSegments(
    lineGeom,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 })
  )
  group.add(webLines)

  const pulseGeom = new THREE.SphereGeometry(0.028, 6, 6)
  const pulses: { mesh: THREE.Mesh; spoke: number; t: number; speed: number }[] = []
  for (let i = 0; i < 12; i++) {
    const mesh = new THREE.Mesh(
      pulseGeom,
      new THREE.MeshBasicMaterial({ color: palette.pulse, transparent: true, opacity: 0.85 })
    )
    group.add(mesh)
    pulses.push({ mesh, spoke: i % SPOKES, t: Math.random(), speed: 0.4 + Math.random() * 0.45 })
  }

  scene.add(new THREE.AmbientLight(palette.ambientLight, 0.45))
  const key = new THREE.DirectionalLight(0xffffff, 1.05)
  key.position.set(2, 1.5, 3)
  scene.add(key)
  const rim = new THREE.PointLight(palette.spiderRim, 0.75, 8)
  rim.position.set(-0.8, 0.6, 2)
  scene.add(rim)

  const frame = newVizLayerFrame(palette)
  const tmp = new THREE.Color()
  let raf = 0
  const segCount = linePts.length / 6

  const animate = () => {
    raf = requestAnimationFrame(animate)
    if (document.hidden) return
    const s = sigRef.current
    const a = actRef.current
    if (!s || !a) return
    stepVizLayerFrame(frame, s, a)
    const stream = getAvatarStreamViz()
    const streamSeed = stream.decodeTokens + Math.floor(frame.t * 2)

    group.rotation.z = Math.sin(frame.t * 0.09) * 0.06
    group.rotation.y = frame.t * 0.11 + Math.sin(frame.t * 0.14) * 0.12
    group.rotation.x = Math.sin(frame.t * 0.08) * 0.04
    const breathe = 1 + Math.sin(frame.t * 1.15) * 0.03 + frame.pulse * 0.07
    group.scale.setScalar(breathe)

    const webMat = webLines.material as THREE.LineBasicMaterial
    webMat.opacity = 0.28 + frame.pulse * 0.5

    const hubMat = hub.material as THREE.MeshStandardMaterial
    hubMat.color.lerp(frame.baseColor, 0.1)
    hubMat.emissive.lerp(frame.baseColor.clone().multiplyScalar(0.35 + frame.pulse * 0.4), 0.12)
    hub.scale.setScalar(1 + frame.pulse * 0.2)

    for (let i = 0; i < SPOKES; i++) {
      const layer = Math.floor((i / SPOKES) * AVATAR_VIS_LAYERS) % AVATAR_VIS_LAYERS
      const hot = frame.layerHot[layer] ?? 0
      const onGpu = layer < a.gpuLayersVisual
      const m = outerNodes[i]!
      const mat = m.material as THREE.MeshStandardMaterial
      const gate = ((i * 19 + streamSeed) % 100) / 100
      const active = hot > 0.25 && gate < 0.12 + hot * 0.25
      tmp.copy(onGpu ? frame.gpuColor : frame.cpuColor)
      if (active) tmp.lerp(frame.hotColor, hot * 0.7)
      tmp.lerp(frame.baseColor, 0.15)
      mat.color.lerp(tmp, 0.12)
      mat.emissive.lerp(tmp.clone().multiplyScalar(active ? 0.45 : 0.1), 0.12)
      m.scale.setScalar(active ? 1 + hot * 0.35 : 1)
    }

    for (let i = 0; i < legNodes.length; i++) {
      const layer = i % AVATAR_VIS_LAYERS
      const hot = (frame.layerHot[layer] ?? 0) * 0.65
      const mat = legNodes[i]!.material as THREE.MeshStandardMaterial
      tmp.setHex(0x475569)
      if (hot > 0.2) tmp.lerp(frame.hotColor, hot * 0.5)
      mat.emissive.lerp(tmp.multiplyScalar(0.25 + hot * 0.3), 0.1)
    }

    for (let s = 0; s < segCount; s++) {
      const isSpoke = s < SPOKES
      const layer = isSpoke
        ? Math.floor((s / SPOKES) * AVATAR_VIS_LAYERS) % AVATAR_VIS_LAYERS
        : Math.floor((s % AVATAR_VIS_LAYERS))
      const hot = frame.layerHot[layer % AVATAR_VIS_LAYERS] ?? 0
      const onGpu = (layer % AVATAR_VIS_LAYERS) < a.gpuLayersVisual
      tmp.copy(onGpu ? frame.gpuColor : frame.cpuColor)
      if (hot > 0.3) tmp.lerp(frame.hotColor, hot * 0.55)
      const o = s * 6
      lineColors[o] = tmp.r
      lineColors[o + 1] = tmp.g
      lineColors[o + 2] = tmp.b
      lineColors[o + 3] = tmp.r
      lineColors[o + 4] = tmp.g
      lineColors[o + 5] = tmp.b
    }
    lineGeom.attributes.color!.needsUpdate = true

    const maxPulses =
      a.phase === 'prefill' ? 12 : a.phase === 'decode' ? 8 : frame.pulse > 0.2 ? 4 : 2
    for (let pi = 0; pi < pulses.length; pi++) {
      const p = pulses[pi]!
      p.mesh.visible = pi < maxPulses
      if (!p.mesh.visible) continue
      p.t += p.speed * 0.016 * (0.5 + frame.pulse)
      if (p.t > 1) {
        p.t = 0
        p.spoke = Math.floor(Math.random() * SPOKES)
      }
      const target = outerPos[p.spoke]!
      p.mesh.position.lerpVectors(hubV, target, p.t)
      const pm = p.mesh.material as THREE.MeshBasicMaterial
      pm.opacity = 0.3 + frame.pulse * 0.7
      pm.color.copy(frame.baseColor)
    }

    renderer.render(scene, camera)
  }
  animate()

  return () => {
    ro.disconnect()
    cancelAnimationFrame(raf)
    renderer.dispose()
    outerGeom.dispose()
    legGeom.dispose()
    pulseGeom.dispose()
    lineGeom.dispose()
    ;(webLines.material as THREE.Material).dispose()
    ;(hub.material as THREE.Material).dispose()
    outerNodes.forEach((m) => (m.material as THREE.Material).dispose())
    legNodes.forEach((m) => (m.material as THREE.Material).dispose())
    pulses.forEach((p) => (p.mesh.material as THREE.Material).dispose())
    if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
  }
}
