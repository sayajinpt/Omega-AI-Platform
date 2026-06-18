import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InputPipeline, ModelInfo, PipelineNode } from '@omega/sdk'
import { engineClient } from '../../lib/engine'
import { InputPipelineCanvas } from './InputPipelineCanvas'
import { OrchestratorPromptChain } from './OrchestratorPromptChain'
import { autoLayoutPipeline } from '../../lib/pipeline-layout'

const NODE_KINDS: PipelineNode['kind'][] = [
  'user_input',
  'chat_orchestrator',
  'proxy_model',
  'tts_model',
  'image_model'
]

function newPipelineShell(scope: InputPipeline['scope']): InputPipeline {
  const inputId = `in-${Date.now().toString(36)}`
  const orchId = `orch-${Date.now().toString(36)}`
  const base: InputPipeline = {
    id: `pipe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: scope === 'content' ? 'Content pipeline' : 'Chat pipeline',
    scope,
    nodes: [
      { id: inputId, kind: 'user_input', label: 'User input' },
      { id: orchId, kind: 'chat_orchestrator', label: 'Chat orchestrator' }
    ],
    edges: [{ from: inputId, to: orchId }],
    updatedAt: 0
  }
  return { ...base, layout: autoLayoutPipeline(base) }
}

function isBuiltinPipeline(p: InputPipeline): boolean {
  if (p.builtin) return true
  return p.name === 'Chat (default)' || p.name === 'Content Studio (default)'
}

export function InputBuilderTab({ models }: { models: ModelInfo[] }) {
  const [list, setList] = useState<InputPipeline[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<InputPipeline | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [builderView, setBuilderView] = useState<'flow' | 'prompts'>('flow')

  const selected = useMemo(() => list.find((p) => p.id === selectedId) ?? null, [list, selectedId])

  const reload = useCallback(async () => {
    try {
      const items = await engineClient.inputPipelines.list()
      const rows = Array.isArray(items) ? items : []
      setList(rows)
      setSelectedId((cur) => {
        if (cur && rows.some((p) => p.id === cur)) return cur
        return rows[0]?.id ?? null
      })
    } catch {
      setList([])
      setSelectedId(null)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (selected) {
      setDraft(JSON.parse(JSON.stringify(selected)) as InputPipeline)
      setSelectedNodeId(null)
    }
  }, [selected])

  const createNew = async (scope: InputPipeline['scope']) => {
    const seeded = newPipelineShell(scope)
    setDraft(seeded)
    setSelectedId(seeded.id)
    try {
      const savedPipe = await engineClient.inputPipelines.save(seeded)
      setSelectedId(savedPipe.id)
      setDraft(savedPipe)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
      await reload()
    }
  }

  const saveDraft = async () => {
    if (!draft) return
    const row = await engineClient.inputPipelines.save(draft)
    setSelectedId(row.id)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    await reload()
  }

  const remove = async () => {
    if (!selected) return
    if (isBuiltinPipeline(selected)) {
      alert('Built-in default pipelines cannot be deleted.')
      return
    }
    const id = selected.id
    const name = selected.name
    if (!id) return
    if (!confirm(`Delete pipeline "${name}"?`)) return
    try {
      await engineClient.inputPipelines.delete(id)
      setSelectedId(null)
      setDraft(null)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const setActive = async (scope: 'chat' | 'content') => {
    if (!selected) return
    await engineClient.inputPipelines.setActive(scope, selected.id)
    await reload()
  }

  const addNode = (kind: PipelineNode['kind']) => {
    if (!draft) return
    if (kind === 'user_input' && draft.nodes.some((n) => n.kind === 'user_input')) return
    const id = `n${Date.now().toString(36).slice(-5)}`
    let n: PipelineNode
    switch (kind) {
      case 'user_input':
        n = { id, kind, label: 'User input' }
        break
      case 'chat_orchestrator':
        n = { id, kind, label: 'Chat orchestrator' }
        break
      case 'proxy_model':
        n = { id, kind, label: 'Proxy model', modelId: models[0]?.id ?? '' }
        break
      case 'tts_model':
        n = { id, kind, label: 'TTS model' }
        break
      case 'image_model':
        n = { id, kind, label: 'Image model' }
        break
    }
    const count = draft.nodes.length
    const layout = {
      ...(draft.layout ?? {}),
      [id]: { x: 120 + (count % 3) * 260, y: 120 + Math.floor(count / 3) * 150 }
    }
    setDraft({ ...draft, nodes: [...draft.nodes, n], layout })
    setSelectedNodeId(id)
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800">
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/40 p-3">
        <div className="mb-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void createNew('chat')}
            className="rounded-lg bg-indigo-600 py-1.5 text-xs font-medium"
          >
            + Chat pipeline
          </button>
          <button
            type="button"
            onClick={() => void createNew('content')}
            className="rounded-lg border border-zinc-700 py-1.5 text-xs text-zinc-300"
          >
            + Content pipeline
          </button>
        </div>
        <ul className="space-y-1 text-sm">
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`w-full rounded px-2 py-1.5 text-left ${
                  selectedId === p.id ? 'bg-zinc-800 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                <span className="block truncate">{p.name}</span>
                <span className="text-[10px] text-zinc-500">
                  {p.scope}
                  {isBuiltinPipeline(p) ? ' · default' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {!draft ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          Select or create an input pipeline.
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="min-w-[10rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium"
            />
            <select
              value={draft.scope}
              onChange={(e) =>
                setDraft({ ...draft, scope: e.target.value as InputPipeline['scope'] })
              }
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs"
            >
              <option value="chat">chat</option>
              <option value="content">content</option>
              <option value="custom">custom</option>
            </select>
            <div className="flex flex-wrap gap-1">
              {NODE_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => addNode(k)}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
                >
                  + {k.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
            {(draft.scope === 'chat' || draft.scope === 'content') && (
              <button
                type="button"
                onClick={() => void setActive(draft.scope === 'content' ? 'content' : 'chat')}
                className="rounded-lg border border-emerald-800 px-2 py-1 text-xs text-emerald-400"
              >
                Set active for {draft.scope}
              </button>
            )}
            <button type="button" onClick={() => void saveDraft()} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm">
              {saved ? 'Saved' : 'Save'}
            </button>
            <div className="flex rounded-lg border border-zinc-700 p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setBuilderView('flow')}
                className={`rounded px-2 py-1 ${
                  builderView === 'flow' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                Flow
              </button>
              <button
                type="button"
                onClick={() => setBuilderView('prompts')}
                className={`rounded px-2 py-1 ${
                  builderView === 'prompts' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                Prompt chain
              </button>
            </div>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={!selected || isBuiltinPipeline(selected)}
              title={
                selected && isBuiltinPipeline(selected)
                  ? 'Built-in defaults cannot be deleted'
                  : undefined
              }
              className="rounded-lg border border-red-800 px-3 py-1.5 text-sm text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Delete
            </button>
          </header>
          <p className="border-b border-zinc-800 px-4 py-1.5 text-[11px] leading-relaxed text-zinc-500">
            {builderView === 'flow'
              ? 'Connect nodes in order from User input. Any proxy model between User input and Chat orchestrator runs first; the chat model then uses standard agent mode (not LLM orchestrator) on the proxy output.'
              : 'Edit LLM orchestrator prompts per round. Defaults are built into the runtime; your edits are stored on this pipeline until you restore defaults.'}
          </p>
          {builderView === 'flow' ? (
            <InputPipelineCanvas
              draft={draft}
              models={models}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onChange={setDraft}
            />
          ) : (
            <OrchestratorPromptChain draft={draft} onChange={setDraft} />
          )}
        </div>
      )}
    </div>
  )
}
