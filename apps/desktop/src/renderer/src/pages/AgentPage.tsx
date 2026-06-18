import { engineClient } from '../lib/engine'
import { useEffect, useState } from 'react'
import type { AgentStep, ModelInfo, OmegaConfig, Token } from '@omega/sdk'
import { AgentGraph } from '../components/AgentGraph'

export function AgentPage({
  config,
  models,
  steps,
  onClearSteps,
  onLog
}: {
  config: OmegaConfig
  models: ModelInfo[]
  steps: AgentStep[]
  onClearSteps: () => void
  onLog: (s: string) => void
}) {
  const [input, setInput] = useState('')
  const [modelId, setModelId] = useState(config.defaultModel || models[0]?.id || '')
  const [output, setOutput] = useState('')
  const [stream, setStream] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    const off = engineClient.agent.onToken((t: Token) => setStream((s) => s + t.text))
    return off
  }, [])

  const run = async () => {
    if (!input.trim() || !modelId || running) return
    setRunning(true)
    setOutput('')
    setStream('')
    onClearSteps()
    onLog('agent run started')
    try {
      const result = await engineClient.agent.run({
        model: modelId,
        input: input.trim(),
        systemPrompt: config.systemPrompt,
        maxSteps: 10
      })
      setOutput(result.output)
      onLog('agent finished')
    } catch (e) {
      onLog(`agent error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex w-1/2 flex-col border-r border-zinc-800">
        <header className="border-b border-zinc-800 px-6 py-4">
          <h2 className="text-lg font-semibold">Ωmega Agent</h2>
          <p className="text-sm text-zinc-500">Planner → Executor → Tools → Critic → Respond</p>
        </header>
        <div className="flex flex-1 flex-col gap-3 p-6">
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={5}
            placeholder="Describe a task…"
            className="resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-medium disabled:opacity-40"
            >
              {running ? 'Running…' : 'Run agent'}
            </button>
            {running && (
              <button
                type="button"
                onClick={() => engineClient.agent.abort()}
                className="rounded-xl border border-red-800 px-4 py-2.5 text-sm text-red-400"
              >
                Stop
              </button>
            )}
          </div>
          {(stream || output) && (
            <div className="max-h-48 overflow-y-auto rounded-xl bg-zinc-900 p-4 text-sm text-zinc-300">
              {running ? stream : output}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-1/2 flex-col">
        <header className="border-b border-zinc-800 px-6 py-4">
          <h3 className="font-medium">Execution graph</h3>
        </header>
        <div className="flex-1 overflow-y-auto p-6">
          <AgentGraph steps={steps} />
        </div>
      </div>
    </div>
  )
}
