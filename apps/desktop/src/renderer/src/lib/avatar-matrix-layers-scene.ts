/**
 * Companion viz: stacked 3D "pages" — each layer is a 2D matrix grid (cells + grid lines).
 */
import * as THREE from 'three'
import type { RefObject } from 'react'
import { AVATAR_VIS_LAYERS } from '../../../shared/avatar-layout'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import type { AvatarNeuralActivity } from './avatar-neural-activity'
import { getAvatarStreamViz } from './avatar-stream-viz'
import type { CompanionColorPalette } from '../../../shared/companion-color-scheme'
import { newVizLayerFrame, stepVizLayerFrame } from './avatar-viz-layer-state'

const GRID = 7
const CELL = 0.11
const PAGE_W = GRID * CELL
const PAGE_H = GRID * CELL * 0.88

function layerZ(L: number): number {
  return -0.72 + (L / Math.max(1, AVATAR_VIS_LAYERS - 1)) * 1.44
}

export function mountMatrixLayersScene(ctx: {
  mount: HTMLDivElement
  wrap: HTMLDivElement
  sigRef: RefObject<AvatarSignals>
  actRef: RefObject<AvatarNeuralActivity>
  palette: CompanionColorPalette
}): () => void {
  const { mount, wrap, sigRef, actRef, palette } = ctx
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0.35, 0.15, 2.55)
  camera.lookAt(0, 0, 0)

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

  type Page = {
    root: THREE.Group
    cells: THREE.Mesh[]
    grid: THREE.LineSegments
    scan: THREE.Mesh
  }
  const pages: Page[] = []
  const cellGeom = new THREE.BoxGeometry(CELL * 0.82, CELL * 0.72, 0.018)
  const scanGeom = new THREE.PlaneGeometry(PAGE_W * 0.92, CELL * 0.55)

  for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
    const root = new THREE.Group()
    const z = layerZ(L)
    const fan = (L - (AVATAR_VIS_LAYERS - 1) / 2) * 0.11
    root.position.set(fan * 0.14, L * 0.018, z)
    root.rotation.y = fan * 0.22
    root.rotation.x = -0.12 + L * 0.02

    const pageBack = new THREE.Mesh(
      new THREE.PlaneGeometry(PAGE_W + 0.06, PAGE_H + 0.06),
      new THREE.MeshStandardMaterial({
        color: palette.matrixPage,
        transparent: true,
        opacity: 0.55,
        metalness: 0.2,
        roughness: 0.85,
        side: THREE.DoubleSide
      })
    )
    pageBack.position.z = -0.02
    root.add(pageBack)

    const cells: THREE.Mesh[] = []
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const mat = new THREE.MeshStandardMaterial({
          color: palette.matrixCell,
          emissive: palette.matrixCellEmissive,
          metalness: 0.35,
          roughness: 0.5
        })
        const m = new THREE.Mesh(cellGeom, mat)
        m.position.set(
          (col - (GRID - 1) / 2) * CELL,
          (row - (GRID - 1) / 2) * CELL * 0.88,
          0.01
        )
        root.add(m)
        cells.push(m)
      }
    }

    const gridPts: THREE.Vector3[] = []
    for (let i = 0; i <= GRID; i++) {
      const o = (i - GRID / 2) * CELL
      gridPts.push(new THREE.Vector3(-PAGE_W / 2, o * 0.88, 0.02))
      gridPts.push(new THREE.Vector3(PAGE_W / 2, o * 0.88, 0.02))
      gridPts.push(new THREE.Vector3(o, -PAGE_H / 2, 0.02))
      gridPts.push(new THREE.Vector3(o, PAGE_H / 2, 0.02))
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPts),
      new THREE.LineBasicMaterial({ color: palette.matrixGrid, transparent: true, opacity: 0.45 })
    )
    root.add(grid)

    const scan = new THREE.Mesh(
      scanGeom,
      new THREE.MeshBasicMaterial({
        color: palette.matrixScan,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide
      })
    )
    scan.position.z = 0.04
    scan.visible = false
    root.add(scan)

    group.add(root)
    pages.push({ root, cells, grid, scan })
  }

  scene.add(new THREE.AmbientLight(palette.ambientLight, 0.55))
  const key = new THREE.DirectionalLight(0xe2e8f0, 1.05)
  key.position.set(2, 2.5, 3)
  scene.add(key)
  const rim = new THREE.PointLight(palette.matrixRim, 0.65, 10)
  rim.position.set(-1.2, 0.5, 2)
  scene.add(rim)

  const frame = newVizLayerFrame(palette)
  const tmp = new THREE.Color()
  let raf = 0
  let scanRow = 0

  const animate = () => {
    raf = requestAnimationFrame(animate)
    if (document.hidden) return
    const s = sigRef.current
    const a = actRef.current
    if (!s || !a) return
    stepVizLayerFrame(frame, s, a)
    const stream = getAvatarStreamViz()
    const streamSeed = stream.decodeTokens + Math.floor(frame.t * 2)

    group.rotation.y = Math.sin(frame.t * 0.11) * 0.18 + frame.t * 0.06
    group.rotation.x = Math.sin(frame.t * 0.07) * 0.05
    const breathe = 1 + Math.sin(frame.t * 1.1) * 0.025 + frame.pulse * 0.06
    group.scale.setScalar(breathe)

    scanRow = (scanRow + 0.35 + frame.pulse * 0.8) % GRID

    for (let L = 0; L < AVATAR_VIS_LAYERS; L++) {
      const page = pages[L]!
      const hot = frame.layerHot[L] ?? 0
      const onGpu = L < a.gpuLayersVisual
      const gridMat = page.grid.material as THREE.LineBasicMaterial
      gridMat.color.copy(onGpu ? frame.gpuColor : frame.cpuColor)
      gridMat.opacity = 0.2 + hot * 0.55

      page.scan.visible = hot > 0.35 && (a.phase === 'prefill' || a.phase === 'decode')
      if (page.scan.visible) {
        const row = Math.floor(scanRow) % GRID
        page.scan.position.y = (row - (GRID - 1) / 2) * CELL * 0.88
        const sm = page.scan.material as THREE.MeshBasicMaterial
        sm.opacity = 0.2 + hot * 0.5
        sm.color.copy(frame.baseColor)
      }

      for (let i = 0; i < page.cells.length; i++) {
        const row = Math.floor(i / GRID)
        const col = i % GRID
        const mat = page.cells[i]!.material as THREE.MeshStandardMaterial
        const gate = ((L * 13 + row * 7 + col * 11 + streamSeed) % 100) / 100
        const nearScan = Math.abs(row - scanRow) < 0.85
        const active = hot > 0.2 && (gate < 0.08 + hot * 0.2 || nearScan)
        tmp.copy(onGpu ? frame.gpuColor : frame.cpuColor)
        if (active) tmp.lerp(frame.hotColor, hot * 0.65)
        tmp.lerp(frame.baseColor, 0.12)
        mat.color.lerp(tmp, 0.14)
        mat.emissive.lerp(tmp.clone().multiplyScalar(active ? 0.35 : 0.06), 0.14)
        const lift = active ? 0.04 + hot * 0.06 : 0
        page.cells[i]!.position.z = 0.01 + lift
        page.cells[i]!.scale.setScalar(active ? 1 + hot * 0.25 : 1)
      }
    }

    renderer.render(scene, camera)
  }
  animate()

  return () => {
    ro.disconnect()
    cancelAnimationFrame(raf)
    renderer.dispose()
    cellGeom.dispose()
    scanGeom.dispose()
    pages.forEach((p) => {
      p.cells.forEach((c) => {
        c.geometry.dispose()
        ;(c.material as THREE.Material).dispose()
      })
      p.grid.geometry.dispose()
      ;(p.grid.material as THREE.Material).dispose()
      p.scan.geometry.dispose()
      ;(p.scan.material as THREE.Material).dispose()
      p.root.children.forEach((ch) => {
        if (ch instanceof THREE.Mesh) {
          ch.geometry.dispose()
          ;(ch.material as THREE.Material).dispose()
        }
      })
    })
    if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
  }
}
