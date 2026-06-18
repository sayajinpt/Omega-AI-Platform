import type { InputPipeline, PipelineEdge } from '@omega/sdk'

export const PIPELINE_NODE_W = 220
export const PIPELINE_NODE_H = 96

const KIND_COLOR: Record<string, string> = {
  user_input: 'border-sky-500/60 bg-sky-950/40',
  chat_orchestrator: 'border-indigo-500/60 bg-indigo-950/40',
  proxy_model: 'border-violet-500/60 bg-violet-950/40',
  tts_model: 'border-emerald-500/60 bg-emerald-950/40',
  image_model: 'border-amber-500/60 bg-amber-950/40'
}

export function pipelineNodeTone(kind: string): string {
  return KIND_COLOR[kind] ?? KIND_COLOR.proxy_model
}

export function getPipelineNodePosition(
  pipeline: InputPipeline,
  nodeId: string,
  index: number
): { x: number; y: number } {
  const saved = pipeline.layout?.[nodeId]
  if (saved) return saved
  const col = index % 3
  const row = Math.floor(index / 3)
  return { x: 72 + col * 280, y: 72 + row * 150 }
}

export function autoLayoutPipeline(pipeline: InputPipeline): Record<string, { x: number; y: number }> {
  const incoming = new Map<string, number>()
  for (const n of pipeline.nodes) incoming.set(n.id, 0)
  for (const e of pipeline.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)

  const depth = new Map<string, number>()
  const queue = pipeline.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id)
  for (const id of queue) depth.set(id, 0)

  const outEdges = new Map<string, PipelineEdge[]>()
  for (const e of pipeline.edges) {
    const list = outEdges.get(e.from) ?? []
    list.push(e)
    outEdges.set(e.from, list)
  }

  const q = [...queue]
  while (q.length) {
    const id = q.shift()!
    const d = depth.get(id) ?? 0
    for (const e of outEdges.get(id) ?? []) {
      const next = Math.max(depth.get(e.to) ?? 0, d + 1)
      depth.set(e.to, next)
      incoming.set(e.to, (incoming.get(e.to) ?? 1) - 1)
      if ((incoming.get(e.to) ?? 0) <= 0) q.push(e.to)
    }
  }
  for (const n of pipeline.nodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0)
  }

  const byLayer = new Map<number, string[]>()
  for (const n of pipeline.nodes) {
    const layer = depth.get(n.id) ?? 0
    const list = byLayer.get(layer) ?? []
    list.push(n.id)
    byLayer.set(layer, list)
  }

  const layout: Record<string, { x: number; y: number }> = {}
  for (const [layer, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, i) => {
      layout[id] = { x: 80 + layer * 300, y: 80 + i * 150 }
    })
  }
  return layout
}

export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const x1 = a.x + PIPELINE_NODE_W
  const y1 = a.y + PIPELINE_NODE_H / 2
  const x2 = b.x
  const y2 = b.y + PIPELINE_NODE_H / 2
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}
