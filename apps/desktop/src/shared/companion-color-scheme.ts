/** User-editable companion animation colors (hex #rrggbb). */
export type CompanionCustomColorKey =
  | 'idle'
  | 'loading'
  | 'prefill'
  | 'active'
  | 'error'
  | 'gpu'
  | 'cpu'
  | 'hot'
  | 'node'
  | 'ring'
  | 'pulse'

export type CompanionCustomColors = Record<CompanionCustomColorKey, string>

/** @deprecated Legacy preset ids — used only for one-time migration from localStorage. */
export type CompanionColorScheme = 'omega' | 'aurora' | 'ember'

export type CompanionColorPalette = {
  gpu: number
  cpu: number
  hot: number
  idle: number
  loading: number
  prefill: number
  active: number
  error: number
  node: number
  nodeEmissive: number
  ring: number
  pulse: number
  ambientLight: number
  rimLight: number
  matrixPage: number
  matrixCell: number
  matrixCellEmissive: number
  matrixGrid: number
  matrixScan: number
  matrixRim: number
  spiderHub: number
  spiderHubEmissive: number
  spiderOuter: number
  spiderOuterEmissive: number
  spiderLeg: number
  spiderLegEmissive: number
  spiderRim: number
}

export const COMPANION_COLOR_FIELD_GROUPS: Array<{
  title: string
  fields: Array<{ key: CompanionCustomColorKey; label: string; hint?: string }>
}> = [
  {
    title: 'Connection states',
    fields: [
      { key: 'idle', label: 'Idle', hint: 'quiet links' },
      { key: 'loading', label: 'Loading', hint: 'weight load' },
      { key: 'prefill', label: 'Prefill', hint: 'attention' },
      { key: 'active', label: 'Active', hint: 'decode / speak' },
      { key: 'error', label: 'Error' }
    ]
  },
  {
    title: 'Hardware accents',
    fields: [
      { key: 'gpu', label: 'GPU layers' },
      { key: 'cpu', label: 'CPU offload' },
      { key: 'hot', label: 'Hot' }
    ]
  },
  {
    title: 'Nodes & pulses',
    fields: [
      { key: 'node', label: 'Nodes' },
      { key: 'ring', label: 'Layer rings' },
      { key: 'pulse', label: 'Traveling pulses' }
    ]
  }
]

const OMEGA_PALETTE: CompanionColorPalette = {
  gpu: 0x22d3ee,
  cpu: 0x6366f1,
  hot: 0xfbbf24,
  idle: 0x818cf8,
  loading: 0xa78bfa,
  prefill: 0xfbbf24,
  active: 0x22d3ee,
  error: 0xef4444,
  node: 0x818cf8,
  nodeEmissive: 0x312e81,
  ring: 0x4338ca,
  pulse: 0x22d3ee,
  ambientLight: 0x8888ff,
  rimLight: 0x22d3ee,
  matrixPage: 0x0f172a,
  matrixCell: 0x1e293b,
  matrixCellEmissive: 0x0f172a,
  matrixGrid: 0x334155,
  matrixScan: 0x22d3ee,
  matrixRim: 0x38bdf8,
  spiderHub: 0xa78bfa,
  spiderHubEmissive: 0x4c1d95,
  spiderOuter: 0x818cf8,
  spiderOuterEmissive: 0x312e81,
  spiderLeg: 0x64748b,
  spiderLegEmissive: 0x1e293b,
  spiderRim: 0xc084fc
}

/** @internal Legacy presets for migration only. */
export const COMPANION_COLOR_PALETTES: Record<CompanionColorScheme, CompanionColorPalette> = {
  omega: OMEGA_PALETTE,
  aurora: {
    gpu: 0x34d399,
    cpu: 0x059669,
    hot: 0xfde047,
    idle: 0x6ee7b7,
    loading: 0x5eead4,
    prefill: 0xfde047,
    active: 0x2dd4bf,
    error: 0xf87171,
    node: 0x10b981,
    nodeEmissive: 0x064e3b,
    ring: 0x047857,
    pulse: 0x34d399,
    ambientLight: 0x88ffcc,
    rimLight: 0x34d399,
    matrixPage: 0x022c22,
    matrixCell: 0x134e4a,
    matrixCellEmissive: 0x022c22,
    matrixGrid: 0x115e59,
    matrixScan: 0x34d399,
    matrixRim: 0x2dd4bf,
    spiderHub: 0x5eead4,
    spiderHubEmissive: 0x134e4a,
    spiderOuter: 0x34d399,
    spiderOuterEmissive: 0x064e3b,
    spiderLeg: 0x475569,
    spiderLegEmissive: 0x134e4a,
    spiderRim: 0x6ee7b7
  },
  ember: {
    gpu: 0xfb923c,
    cpu: 0xe11d48,
    hot: 0xfacc15,
    idle: 0xf472b6,
    loading: 0xc026d3,
    prefill: 0xfacc15,
    active: 0xfb923c,
    error: 0xdc2626,
    node: 0xf43f5e,
    nodeEmissive: 0x881337,
    ring: 0x9f1239,
    pulse: 0xfb923c,
    ambientLight: 0xffaa88,
    rimLight: 0xfb923c,
    matrixPage: 0x1c0a12,
    matrixCell: 0x4c0519,
    matrixCellEmissive: 0x1c0a12,
    matrixGrid: 0x7f1d1d,
    matrixScan: 0xfb923c,
    matrixRim: 0xf97316,
    spiderHub: 0xc026d3,
    spiderHubEmissive: 0x701a75,
    spiderOuter: 0xf43f5e,
    spiderOuterEmissive: 0x881337,
    spiderLeg: 0x78716c,
    spiderLegEmissive: 0x44403c,
    spiderRim: 0xf472b6
  }
}

export const DEFAULT_COMPANION_CUSTOM_COLORS: CompanionCustomColors =
  paletteToCustomColors(OMEGA_PALETTE)

function rgbFromHex(hex: number): { r: number; g: number; b: number } {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 }
}

function hexFromRgb(r: number, g: number, b: number): number {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)
}

function darken(hex: number, amount: number): number {
  const { r, g, b } = rgbFromHex(hex)
  const f = 1 - Math.max(0, Math.min(1, amount))
  return hexFromRgb(Math.round(r * f), Math.round(g * f), Math.round(b * f))
}

function lighten(hex: number, amount: number): number {
  const { r, g, b } = rgbFromHex(hex)
  const f = Math.max(0, Math.min(1, amount))
  return hexFromRgb(
    Math.round(r + (255 - r) * f),
    Math.round(g + (255 - g) * f),
    Math.round(b + (255 - b) * f)
  )
}

function blend(a: number, b: number, t: number): number {
  const ar = rgbFromHex(a)
  const br = rgbFromHex(b)
  const u = Math.max(0, Math.min(1, t))
  return hexFromRgb(
    Math.round(ar.r + (br.r - ar.r) * u),
    Math.round(ar.g + (br.g - ar.g) * u),
    Math.round(ar.b + (br.b - ar.b) * u)
  )
}

export function numberToHexColor(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`
}

export function parseHexColor(input: string, fallback: number): number {
  const raw = input.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return fallback
  return parseInt(raw, 16)
}

export function normalizeHexColor(input: string, fallback: string): string {
  const n = parseHexColor(input, parseHexColor(fallback, 0x818cf8))
  return numberToHexColor(n)
}

export function paletteToCustomColors(palette: CompanionColorPalette): CompanionCustomColors {
  return {
    idle: numberToHexColor(palette.idle),
    loading: numberToHexColor(palette.loading),
    prefill: numberToHexColor(palette.prefill),
    active: numberToHexColor(palette.active),
    error: numberToHexColor(palette.error),
    gpu: numberToHexColor(palette.gpu),
    cpu: numberToHexColor(palette.cpu),
    hot: numberToHexColor(palette.hot),
    node: numberToHexColor(palette.node),
    ring: numberToHexColor(palette.ring),
    pulse: numberToHexColor(palette.pulse)
  }
}

export function buildCompanionColorPalette(colors: CompanionCustomColors): CompanionColorPalette {
  const idle = parseHexColor(colors.idle, OMEGA_PALETTE.idle)
  const loading = parseHexColor(colors.loading, OMEGA_PALETTE.loading)
  const prefill = parseHexColor(colors.prefill, OMEGA_PALETTE.prefill)
  const active = parseHexColor(colors.active, OMEGA_PALETTE.active)
  const error = parseHexColor(colors.error, OMEGA_PALETTE.error)
  const gpu = parseHexColor(colors.gpu, OMEGA_PALETTE.gpu)
  const cpu = parseHexColor(colors.cpu, OMEGA_PALETTE.cpu)
  const hot = parseHexColor(colors.hot, OMEGA_PALETTE.hot)
  const node = parseHexColor(colors.node, OMEGA_PALETTE.node)
  const ring = parseHexColor(colors.ring, OMEGA_PALETTE.ring)
  const pulse = parseHexColor(colors.pulse, OMEGA_PALETTE.pulse)

  const nodeEmissive = darken(node, 0.55)
  const ambientLight = lighten(blend(idle, active, 0.45), 0.25)
  const rimLight = active
  const matrixPage = darken(idle, 0.72)
  const matrixCell = darken(node, 0.35)
  const matrixCellEmissive = darken(matrixCell, 0.2)
  const matrixGrid = blend(matrixCell, ring, 0.35)
  const matrixScan = active
  const matrixRim = lighten(active, 0.2)
  const spiderHub = blend(node, loading, 0.35)
  const spiderHubEmissive = darken(spiderHub, 0.5)
  const spiderOuter = node
  const spiderOuterEmissive = nodeEmissive
  const spiderLeg = darken(ring, 0.15)
  const spiderLegEmissive = darken(spiderLeg, 0.45)
  const spiderRim = lighten(blend(node, pulse, 0.5), 0.15)

  return {
    gpu,
    cpu,
    hot,
    idle,
    loading,
    prefill,
    active,
    error,
    node,
    nodeEmissive,
    ring,
    pulse,
    ambientLight,
    rimLight,
    matrixPage,
    matrixCell,
    matrixCellEmissive,
    matrixGrid,
    matrixScan,
    matrixRim,
    spiderHub,
    spiderHubEmissive,
    spiderOuter,
    spiderOuterEmissive,
    spiderLeg,
    spiderLegEmissive,
    spiderRim
  }
}

/** @deprecated Use {@link buildCompanionColorPalette} with custom colors. */
export function getCompanionColorPalette(scheme: CompanionColorScheme): CompanionColorPalette {
  return COMPANION_COLOR_PALETTES[scheme]
}

export function mergeCompanionCustomColors(
  partial: Partial<CompanionCustomColors>
): CompanionCustomColors {
  const out = { ...DEFAULT_COMPANION_CUSTOM_COLORS }
  for (const key of Object.keys(out) as CompanionCustomColorKey[]) {
    if (partial[key]) out[key] = normalizeHexColor(partial[key]!, out[key])
  }
  return out
}
