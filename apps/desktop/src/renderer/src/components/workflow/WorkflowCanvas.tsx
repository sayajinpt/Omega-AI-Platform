import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo, Workflow, WorkflowEdge, WorkflowNode } from '@omega/sdk'
import {
  WORKFLOW_NODE_H,
  WORKFLOW_NODE_W,
  autoLayoutWorkflow,
  edgePath,
  getNodePosition,
  workflowNodeTone
} from '../../lib/workflow-layout'
import { WorkflowNodeEditor } from './WorkflowNodeEditor'

const KIND_LABEL: Record<string, string> = {
  prompt: 'Prompt',
  tool: 'Tool',
  agent: 'Agent',
  branch: 'Branch',
  set: 'Set var'
}

export function WorkflowCanvas({
  draft,
  models,
  activeNodeId,
  onChange,
  onSelectNode,
  selectedNodeId
}: {
  draft: Workflow
  models: ModelInfo[]
  activeNodeId?: string | null
  onChange: (wf: Workflow) => void
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [drag, setDrag] = useState<{
    nodeId: string
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const [panDrag, setPanDrag] = useState<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    draft.nodes.forEach((n, i) => map.set(n.id, getNodePosition(draft, n.id, i)))
    return map
  }, [draft])

  const setLayout = useCallback(
    (nodeId: string, pos: { x: number; y: number }) => {
      onChange({
        ...draft,
        layout: { ...(draft.layout ?? {}), [nodeId]: pos }
      })
    },
    [draft, onChange]
  )

  const addEdge = useCallback(
    (from: string, to: string) => {
      if (from === to) return
      if (draft.edges.some((e) => e.from === from && e.to === to)) return
      onChange({ ...draft, edges: [...draft.edges, { from, to }] })
    },
    [draft, onChange]
  )

  const removeEdge = (from: string, to: string) => {
    onChange({ ...draft, edges: draft.edges.filter((e) => !(e.from === from && e.to === to)) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLinkFrom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (drag) {
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        setLayout(drag.nodeId, { x: drag.originX + dx, y: drag.originY + dy })
      }
      if (panDrag) {
        setPan({ x: panDrag.ox + (e.clientX - panDrag.x), y: panDrag.oy + (e.clientY - panDrag.y) })
      }
    }
    const onUp = () => {
      setDrag(null)
      setPanDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, panDrag, setLayout])

  const selectedNode = draft.nodes.find((n) => n.id === selectedNodeId) ?? null

  const updateNode = (id: string, patch: Partial<WorkflowNode>) => {
    onChange({
      ...draft,
      nodes: draft.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as WorkflowNode) : n))
    })
  }

  const nodeSubtitle = (n: WorkflowNode): string => {
    if (n.kind === 'prompt') return (n.prompt || 'Empty prompt').slice(0, 48)
    if (n.kind === 'tool') return n.tool || 'pick a tool'
    if (n.kind === 'agent') return (n.input || 'agent task').slice(0, 48)
    if (n.kind === 'branch') return n.condition || 'condition'
    return (n.value || 'set value').slice(0, 48)
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,#27272a_1px,transparent_0)] bg-[length:24px_24px] bg-zinc-950">
        <div className="absolute left-3 top-3 z-20 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => onChange({ ...draft, layout: autoLayoutWorkflow(draft) })}
          >
            Auto-layout
          </button>
          <button
            type="button"
            className="rounded-lg border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => setPan({ x: 0, y: 0 })}
          >
            Reset view
          </button>
          {linkFrom ? (
            <span className="rounded-lg bg-indigo-600/30 px-2.5 py-1 text-xs text-indigo-200">
              Linking… click target input port (Esc to cancel)
            </span>
          ) : null}
        </div>

        <div
          ref={canvasRef}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          onMouseDown={(e) => {
            if (e.target !== canvasRef.current && !(e.target as HTMLElement).dataset.canvasBg) return
            onSelectNode(null)
            setLinkFrom(null)
            setPanDrag({ x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y })
          }}
          data-canvas-bg="1"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            style={{ width: 4000, height: 4000 }}
            data-canvas-bg="1"
          >
            {draft.edges.map((e) => {
              const a = positions.get(e.from)
              const b = positions.get(e.to)
              if (!a || !b) return null
              const selected =
                selectedNodeId === e.from || selectedNodeId === e.to
              return (
                <path
                  key={`${e.from}-${e.to}`}
                  d={edgePath(a, b)}
                  fill="none"
                  stroke={selected ? '#818cf8' : '#52525b'}
                  strokeWidth={selected ? 2.5 : 2}
                  markerEnd="url(#wf-arrow)"
                />
              )
            })}
            <defs>
              <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="#71717a" />
              </marker>
            </defs>
          </svg>

          {draft.nodes.map((node, index) => {
            const pos = positions.get(node.id) ?? getNodePosition(draft, node.id, index)
            const isSelected = selectedNodeId === node.id
            const isActive = activeNodeId === node.id
            return (
              <div
                key={node.id}
                className={`absolute select-none rounded-xl border-2 shadow-lg transition-shadow ${workflowNodeTone(node.kind)} ${
                  isSelected ? 'ring-2 ring-indigo-400' : ''
                } ${isActive ? 'ring-2 ring-emerald-400 shadow-emerald-900/30' : ''}`}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: WORKFLOW_NODE_W,
                  minHeight: WORKFLOW_NODE_H
                }}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  onSelectNode(node.id)
                  setDrag({
                    nodeId: node.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    originX: pos.x,
                    originY: pos.y
                  })
                }}
              >
                <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
                  <span className="rounded bg-zinc-950/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">
                    {KIND_LABEL[node.kind] ?? node.kind}
                  </span>
                  <input
                    value={node.label}
                    onChange={(e) => updateNode(node.id, { label: e.target.value })}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-zinc-100 outline-none"
                  />
                </div>
                <p className="px-3 py-2 text-[10px] leading-snug text-zinc-500">{nodeSubtitle(node)}</p>
                {node.output ? (
                  <p className="px-3 pb-2 font-mono text-[9px] text-indigo-400/80">→ {`{{${node.output}}}`}</p>
                ) : null}

                <button
                  type="button"
                  title="Connect from this node"
                  className={`absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 ${
                    linkFrom === node.id
                      ? 'border-indigo-300 bg-indigo-500'
                      : 'border-zinc-600 bg-zinc-800 hover:border-indigo-400 hover:bg-indigo-600'
                  }`}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    setLinkFrom(node.id)
                  }}
                />
                <button
                  type="button"
                  title="Connect to this node"
                  className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-zinc-600 bg-zinc-800 hover:border-emerald-400 hover:bg-emerald-600"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    if (linkFrom && linkFrom !== node.id) {
                      addEdge(linkFrom, node.id)
                      setLinkFrom(null)
                    } else {
                      setLinkFrom(node.id)
                    }
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/50">
        <header className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {selectedNode ? 'Node properties' : 'Canvas'}
        </header>
        <div className="flex-1 overflow-y-auto p-3">
          {selectedNode ? (
            <>
              <WorkflowNodeEditor
                node={selectedNode}
                models={models}
                onChange={(p) => updateNode(selectedNode.id, p)}
              />
              <button
                type="button"
                className="mt-4 w-full rounded-lg border border-red-900/60 py-1.5 text-xs text-red-400 hover:bg-red-950/30"
                onClick={() => {
                  onChange({
                    ...draft,
                    nodes: draft.nodes.filter((n) => n.id !== selectedNode.id),
                    edges: draft.edges.filter(
                      (e) => e.from !== selectedNode.id && e.to !== selectedNode.id
                    ),
                    layout: Object.fromEntries(
                      Object.entries(draft.layout ?? {}).filter(([k]) => k !== selectedNode.id)
                    )
                  })
                  onSelectNode(null)
                }}
              >
                Delete node
              </button>
            </>
          ) : (
            <p className="text-xs text-zinc-500">
              Drag nodes to arrange. Click an <strong>output</strong> port (right), then an{' '}
              <strong>input</strong> port (left) on another node to connect. Select a node to edit fields.
            </p>
          )}

          <section className="mt-6">
            <h4 className="mb-2 text-[10px] font-semibold uppercase text-zinc-500">Connections</h4>
            {draft.edges.length === 0 ? (
              <p className="text-[10px] text-zinc-600">No edges yet.</p>
            ) : (
              <ul className="space-y-1">
                {draft.edges.map((e: WorkflowEdge) => (
                  <li
                    key={`${e.from}-${e.to}`}
                    className="flex items-center justify-between rounded bg-zinc-950/80 px-2 py-1 text-[10px]"
                  >
                    <span className="text-zinc-400">
                      {e.from} → {e.to}
                    </span>
                    <button
                      type="button"
                      className="text-red-400 hover:text-red-300"
                      onClick={() => removeEdge(e.from, e.to)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </div>
  )
}
