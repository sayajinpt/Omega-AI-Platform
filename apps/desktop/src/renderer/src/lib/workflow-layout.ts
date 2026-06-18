import type { Workflow, WorkflowEdge } from '@omega/sdk'

export const WORKFLOW_NODE_W = 220
export const WORKFLOW_NODE_H = 96

const KIND_COLOR: Record<string, string> = {
  prompt: 'border-indigo-500/60 bg-indigo-950/40',
  tool: 'border-emerald-500/60 bg-emerald-950/40',
  agent: 'border-violet-500/60 bg-violet-950/40',
  branch: 'border-amber-500/60 bg-amber-950/40',
  set: 'border-zinc-500/60 bg-zinc-900/60'
}

export function workflowNodeTone(kind: string): string {
  return KIND_COLOR[kind] ?? KIND_COLOR.set
}

export function getNodePosition(
  workflow: Workflow,
  nodeId: string,
  index: number
): { x: number; y: number } {
  const saved = workflow.layout?.[nodeId]
  if (saved) return saved
  const col = index % 3
  const row = Math.floor(index / 3)
  return { x: 72 + col * 280, y: 72 + row * 150 }
}

/** Layer nodes left-to-right for auto-layout. */
export function autoLayoutWorkflow(workflow: Workflow): Record<string, { x: number; y: number }> {
  const incoming = new Map<string, number>()
  for (const n of workflow.nodes) incoming.set(n.id, 0)
  for (const e of workflow.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)

  const depth = new Map<string, number>()
  const queue = workflow.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id)
  for (const id of queue) depth.set(id, 0)

  const outEdges = new Map<string, WorkflowEdge[]>()
  for (const e of workflow.edges) {
    const list = outEdges.get(e.from) ?? []
    list.push(e)
    outEdges.set(e.from, list)
  }

  const order: string[] = []
  const q = [...queue]
  while (q.length) {
    const id = q.shift()!
    order.push(id)
    const d = depth.get(id) ?? 0
    for (const e of outEdges.get(id) ?? []) {
      const next = Math.max(depth.get(e.to) ?? 0, d + 1)
      depth.set(e.to, next)
      incoming.set(e.to, (incoming.get(e.to) ?? 1) - 1)
      if ((incoming.get(e.to) ?? 0) <= 0) q.push(e.to)
    }
  }
  for (const n of workflow.nodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0)
    if (!order.includes(n.id)) order.push(n.id)
  }

  const byLayer = new Map<number, string[]>()
  for (const n of workflow.nodes) {
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

export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number }
): string {
  const x1 = from.x + WORKFLOW_NODE_W
  const y1 = from.y + WORKFLOW_NODE_H / 2
  const x2 = to.x
  const y2 = to.y + WORKFLOW_NODE_H / 2
  const dx = Math.max(60, (x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}
