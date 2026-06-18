import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ModelInfo,
  OmegaConfig,
  Workflow,
  WorkflowNode,
  WorkflowRunEvent
} from '@omega/sdk'
import { engineClient } from '../lib/engine'
import { WorkflowCanvas } from '../components/workflow/WorkflowCanvas'
import { autoLayoutWorkflow } from '../lib/workflow-layout'

const STARTER: Omit<Workflow, 'id' | 'updatedAt'> = {
  name: 'Research → Summarize',
  description: 'Fetch a URL, summarize, save to memory.',
  nodes: [
    {
      id: 'n1',
      kind: 'tool',
      label: 'Fetch URL',
      tool: 'web_fetch',
      args: { url: '{{url}}' },
      output: 'fetched'
    },
    {
      id: 'n2',
      kind: 'prompt',
      label: 'Summarize',
      prompt: 'Summarize the following content in 5 bullet points:\n\n{{fetched}}',
      maxTokens: 600,
      temperature: 0.4,
      output: 'summary'
    },
    {
      id: 'n3',
      kind: 'tool',
      label: 'Save to memory',
      tool: 'add_memory',
      args: { kind: 'fact', content: '{{summary}}' }
    }
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' }
  ]
}

function starterWithLayout(): Omit<Workflow, 'id' | 'updatedAt'> {
  const base = { ...STARTER, id: 'draft', updatedAt: 0 } as Workflow
  return { ...STARTER, layout: autoLayoutWorkflow(base) }
}

export function WorkflowsPage({
  config,
  models,
  onLog
}: {
  config: OmegaConfig
  models: ModelInfo[]
  onLog: (s: string) => void
}) {
  const [list, setList] = useState<Workflow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Workflow | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [vars, setVars] = useState('{\n  "url": "https://example.com"\n}')
  const [events, setEvents] = useState<WorkflowRunEvent[]>([])
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<Record<string, string>>({})
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)

  const selected = useMemo(() => list.find((w) => w.id === selectedId) ?? null, [list, selectedId])

  const reload = useCallback(async (opts?: { preferId?: string | null }) => {
    const items = await engineClient.workflows.list()
    setList(items)
    setSelectedId((current) => {
      if (opts?.preferId !== undefined) {
        if (opts.preferId && items.some((w) => w.id === opts.preferId)) return opts.preferId
        return items[0]?.id ?? null
      }
      if (current && items.some((w) => w.id === current)) return current
      return items[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    void reload()
    return engineClient.workflows.onEvent((e) => {
      setEvents((prev) => [...prev, e].slice(-200))
      if (e.kind === 'nodeStart' && 'nodeId' in e) setActiveNodeId(e.nodeId)
      if (e.kind === 'nodeDone' || e.kind === 'nodeError') setActiveNodeId(null)
      if (e.kind === 'done') setActiveNodeId(null)
    })
  }, [reload])

  useEffect(() => {
    if (selected) {
      setDraft(structuredClone(selected))
      setSelectedNodeId(null)
    } else {
      setDraft(null)
    }
  }, [selected])

  const createNew = async () => {
    try {
      const seeded = starterWithLayout()
      const wf = await engineClient.workflows.save({
        ...seeded,
        name: `Workflow ${list.length + 1}`,
        id: undefined as unknown as string
      } as never)
      await reload({ preferId: wf.id })
      onLog(`created workflow ${wf.name}`)
    } catch (e) {
      onLog(`create workflow failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const saveDraft = async () => {
    if (!draft) return
    const saved = await engineClient.workflows.save(draft)
    setSelectedId(saved.id)
    onLog(`saved workflow ${saved.name}`)
    await reload()
  }

  const remove = async () => {
    if (!selected) return
    if (!confirm(`Delete workflow "${selected.name}"?`)) return
    const name = selected.name
    try {
      await engineClient.workflows.delete(selected.id)
      await reload({ preferId: null })
      onLog(`deleted workflow ${name}`)
    } catch (e) {
      onLog(`delete workflow failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const run = async () => {
    if (!selected) return
    setOutput({})
    setEvents([])
    setRunning(true)
    try {
      const parsed = vars.trim() ? (JSON.parse(vars) as Record<string, string>) : {}
      const r = await engineClient.workflows.run(selected.id, parsed, config.defaultModel)
      setOutput(r.outputs ?? {})
      onLog(`workflow done (${selected.name})`)
    } catch (e) {
      onLog(`workflow error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
      setActiveNodeId(null)
    }
  }

  const stop = async () => {
    await engineClient.workflows.abort()
    setRunning(false)
    setActiveNodeId(null)
  }

  const addNode = (kind: WorkflowNode['kind']) => {
    if (!draft) return
    const id = `n${Date.now().toString(36).slice(-4)}`
    let n: WorkflowNode
    switch (kind) {
      case 'prompt':
        n = { id, kind: 'prompt', label: 'Prompt', prompt: '', maxTokens: 512, temperature: 0.5 }
        break
      case 'tool':
        n = { id, kind: 'tool', label: 'Tool', tool: '', args: {} }
        break
      case 'agent':
        n = { id, kind: 'agent', label: 'Agent', input: '', maxSteps: 6 }
        break
      case 'branch':
        n = { id, kind: 'branch', label: 'Branch', condition: '' }
        break
      case 'set':
        n = { id, kind: 'set', label: 'Set var', value: '' }
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
    <div className="flex h-full">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/40 p-3">
        <button
          type="button"
          onClick={createNew}
          className="mb-3 w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium"
        >
          + New workflow
        </button>
        <ul className="space-y-1 text-sm">
          {list.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => setSelectedId(w.id)}
                className={`w-full rounded px-2 py-1.5 text-left ${
                  selectedId === w.id ? 'bg-zinc-800 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {w.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {!draft ? (
        <div className="flex flex-1 items-center justify-center text-zinc-500">
          Select or create a workflow.
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="min-w-[10rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium"
            />
            <input
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Description"
              className="min-w-[12rem] flex-[2] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400"
            />
            <div className="flex flex-wrap gap-1.5">
              {(['prompt', 'tool', 'agent', 'branch', 'set'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => addNode(k)}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1 text-[10px] capitalize text-zinc-300 hover:bg-zinc-800"
                >
                  + {k}
                </button>
              ))}
            </div>
            <button type="button" onClick={saveDraft} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm">
              Save
            </button>
            <button
              type="button"
              onClick={remove}
              className="rounded-lg border border-red-800 px-3 py-1.5 text-sm text-red-400"
            >
              Delete
            </button>
          </header>

          <div className="flex min-h-0 flex-1">
            <WorkflowCanvas
              draft={draft}
              models={models}
              activeNodeId={activeNodeId}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onChange={setDraft}
            />

            <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/30">
              <header className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase text-zinc-500">
                Run
              </header>
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
                <label className="text-[10px] text-zinc-500">Input variables (JSON)</label>
                <textarea
                  value={vars}
                  onChange={(e) => setVars(e.target.value)}
                  rows={5}
                  className="resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[10px]"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={run}
                    disabled={running}
                    className="flex-1 rounded-lg bg-indigo-600 py-2 text-xs font-medium disabled:opacity-40"
                  >
                    {running ? 'Running…' : 'Run'}
                  </button>
                  {running && (
                    <button
                      type="button"
                      onClick={stop}
                      className="rounded-lg border border-red-800 px-2 text-xs text-red-400"
                    >
                      Stop
                    </button>
                  )}
                </div>

                <h4 className="text-[10px] uppercase text-zinc-500">Live events</h4>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-[10px]">
                  {events.map((e, i) => (
                    <li key={i} className="rounded bg-zinc-950 p-1.5">
                      <span className="text-indigo-300">{e.kind}</span>
                      {'nodeId' in e && <span className="text-zinc-500"> {e.nodeId}</span>}
                    </li>
                  ))}
                </ul>

                {Object.keys(output).length > 0 && (
                  <>
                    <h4 className="text-[10px] uppercase text-zinc-500">Outputs</h4>
                    <pre className="max-h-32 overflow-auto rounded bg-zinc-950 p-2 text-[9px] text-emerald-300">
                      {JSON.stringify(output, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}
    </div>
  )
}
