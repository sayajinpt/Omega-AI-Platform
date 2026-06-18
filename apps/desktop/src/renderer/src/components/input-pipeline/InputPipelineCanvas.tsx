import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InputPipeline, ModelInfo, PipelineNode } from '@omega/sdk'
import {
  PIPELINE_NODE_H,
  PIPELINE_NODE_W,
  autoLayoutPipeline,
  edgePath,
  getPipelineNodePosition,
  pipelineNodeTone
} from '../../lib/pipeline-layout'
import { PipelineNodeEditor } from './PipelineNodeEditor'

const KIND_LABEL: Record<string, string> = {
  user_input: 'User input',
  chat_orchestrator: 'Orchestrator',
  proxy_model: 'Proxy model',
  tts_model: 'TTS model',
  image_model: 'Image model'
}

function nodeSubtitle(n: PipelineNode): string {
  if (n.kind === 'chat_orchestrator') return n.modelId || 'default chat model'
  if (n.kind === 'proxy_model') return n.modelId || 'pick model'
  if (n.kind === 'tts_model' || n.kind === 'image_model') return n.modelId || 'role default'
  return 'entry'
}

export function InputPipelineCanvas({
  draft,
  models,
  onChange,
  onSelectNode,
  selectedNodeId
}: {
  draft: InputPipeline
  models: ModelInfo[]
  onChange: (p: InputPipeline) => void
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
    draft.nodes.forEach((n, i) => map.set(n.id, getPipelineNodePosition(draft, n.id, i)))
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

  const updateNode = (id: string, patch: Partial<PipelineNode>) => {
    onChange({
      ...draft,
      nodes: draft.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as PipelineNode) : n))
    })
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,#27272a_1px,transparent_0)] bg-[length:24px_24px] bg-zinc-950">
        <div className="absolute left-3 top-3 z-20 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => onChange({ ...draft, layout: autoLayoutPipeline(draft) })}
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
              const selected = selectedNodeId === e.from || selectedNodeId === e.to
              return (
                <path
                  key={`${e.from}-${e.to}`}
                  d={edgePath(a, b)}
                  fill="none"
                  stroke={selected ? '#818cf8' : '#52525b'}
                  strokeWidth={selected ? 2.5 : 2}
                />
              )
            })}
          </svg>

          {draft.nodes.map((node, index) => {
            const pos = positions.get(node.id) ?? getPipelineNodePosition(draft, node.id, index)
            const isSelected = selectedNodeId === node.id
            return (
              <div
                key={node.id}
                className={`absolute select-none rounded-xl border-2 shadow-lg ${pipelineNodeTone(node.kind)} ${
                  isSelected ? 'ring-2 ring-indigo-400' : ''
                }`}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: PIPELINE_NODE_W,
                  minHeight: PIPELINE_NODE_H
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

                <div className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2">
                  <button
                    type="button"
                    title="Connect from here"
                    className="h-4 w-4 rounded-full border-2 border-indigo-400 bg-zinc-900 hover:bg-indigo-600"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setLinkFrom(node.id)
                    }}
                  />
                </div>
                <div className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2">
                  <button
                    type="button"
                    title="Connect to here"
                    className="h-4 w-4 rounded-full border-2 border-zinc-500 bg-zinc-900 hover:bg-zinc-600"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (linkFrom && linkFrom !== node.id) {
                        addEdge(linkFrom, node.id)
                        setLinkFrom(null)
                      }
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/30">
        <header className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase text-zinc-500">
          Inspector
        </header>
        <div className="flex-1 overflow-y-auto p-3">
          {!selectedNode ? (
            <p className="text-xs text-zinc-500">Select a node to edit.</p>
          ) : (
            <>
              <PipelineNodeEditor
                node={selectedNode}
                models={models}
                onChange={(patch) => updateNode(selectedNode.id, patch)}
              />
              {selectedNode.kind !== 'user_input' && (
                <button
                  type="button"
                  className="mt-4 w-full rounded border border-red-800 py-1.5 text-xs text-red-400"
                  onClick={() => {
                    onChange({
                      ...draft,
                      nodes: draft.nodes.filter((n) => n.id !== selectedNode.id),
                      edges: draft.edges.filter(
                        (e) => e.from !== selectedNode.id && e.to !== selectedNode.id
                      )
                    })
                    onSelectNode(null)
                  }}
                >
                  Delete node
                </button>
              )}
              {draft.edges
                .filter((e) => e.from === selectedNode.id || e.to === selectedNode.id)
                .map((e) => (
                  <button
                    key={`${e.from}-${e.to}`}
                    type="button"
                    className="mt-2 block w-full rounded border border-zinc-700 py-1 text-[10px] text-zinc-400"
                    onClick={() => removeEdge(e.from, e.to)}
                  >
                    Remove edge {e.from.slice(0, 6)} → {e.to.slice(0, 6)}
                  </button>
                ))}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
