import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FinetuneJob,
  FinetuneModality,
  FinetuneModelProfile,
  ModelInfo,
  OmegaConfig
} from '@omega/sdk'
import { engineClient } from '../lib/engine'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { FinetuneDatasetManager } from '../components/finetune/FinetuneDatasetManager'

const MODALITIES: { id: FinetuneModality; label: string; hint: string }[] = [
  { id: 'instruction', label: 'Instruction', hint: 'Alpaca-style instruction / response pairs' },
  { id: 'conversational', label: 'Conversational', hint: 'Multi-turn chat (ChatML messages)' },
  { id: 'chatml', label: 'ChatML', hint: 'Explicit role messages array' },
  { id: 'alpaca', label: 'Alpaca', hint: 'instruction + optional input + output' },
  { id: 'image_to_text', label: 'Image → text', hint: 'image + caption / VLM fine-tune' },
  { id: 'text_to_image', label: 'Text → image', hint: 'prompt + image paths (diffusers)' },
  { id: 'completion', label: 'Completion', hint: 'Plain text continuation' },
  { id: 'embedding', label: 'Embedding', hint: 'Prepare-only / contrastive pairs' }
]

const FINETUNE_AGENT_PROMPT = `You are the Omega Fine-tune Agent. Help the user configure and run local LoRA/SFT jobs.
Use tools: finetune_analyze, finetune_prepare_dataset, finetune_start, finetune_status, finetune_stop.
Always confirm dataset paths, modality, and HuggingFace model ID (hfModelId) when the base weights are GGUF.
Report progress from finetune_status after starting a job.`

type FinetuneTab = 'setup' | 'datasets' | 'training' | 'jobs'

const HYPER_FIELDS: Array<{
  key: keyof NonNullable<FinetuneModelProfile['hyperparams']>
  label: string
  step?: number
  hint?: string
}> = [
  { key: 'epochs', label: 'Epochs' },
  { key: 'learningRate', label: 'Learning rate', step: 0.00001 },
  { key: 'batchSize', label: 'Batch size' },
  { key: 'gradientAccumulation', label: 'Grad accumulation' },
  { key: 'maxSeqLength', label: 'Max sequence length' },
  { key: 'loraRank', label: 'LoRA rank' },
  { key: 'loraAlpha', label: 'LoRA alpha' },
  { key: 'warmupRatio', label: 'Warmup ratio', step: 0.01 },
  { key: 'saveSteps', label: 'Save steps' }
]

export function FinetunePage({
  config,
  models
}: {
  config: OmegaConfig
  models: ModelInfo[]
}) {
  const [tab, setTab] = useState<FinetuneTab>('setup')
  const [modelId, setModelId] = useState(config.defaultModel || models[0]?.id || '')
  const [profile, setProfile] = useState<FinetuneModelProfile | null>(null)
  const [modality, setModality] = useState<FinetuneModality>('instruction')
  const [sourceList, setSourceList] = useState<string[]>([])
  const [hfModelId, setHfModelId] = useState('')
  const [hyper, setHyper] = useState<FinetuneModelProfile['hyperparams'] | null>(null)
  const [preview, setPreview] = useState('')
  const [jobs, setJobs] = useState<FinetuneJob[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agentMode, setAgentMode] = useState(false)
  const [agentInput, setAgentInput] = useState('')
  const [agentLog, setAgentLog] = useState<string[]>([])
  const [jobName, setJobName] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const refreshJobs = useCallback(async () => {
    setJobs(await engineClient.finetune.list())
  }, [])

  const analyze = useCallback(async (id: string) => {
    if (!id) return
    setError(null)
    try {
      const p = await engineClient.finetune.analyze(id)
      setProfile(p)
      setModality(p.primaryModality)
      setHyper({ ...p.hyperparams })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refreshJobs()
    const off = engineClient.finetune.onProgress(() => {
      void refreshJobs()
    })
    return off
  }, [refreshJobs])

  useEffect(() => {
    if (modelId) void analyze(modelId)
  }, [modelId, analyze])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [agentLog, jobs])

  const sources = sourceList

  const prepare = async (): Promise<void> => {
    if (!modelId || sources.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const r = await engineClient.finetune.prepareDataset({ modelId, modality, sources })
      setPreview(r.preview)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const createJob = async (dryRun: boolean): Promise<void> => {
    if (!modelId || sources.length === 0) {
      setError('Select a model and at least one dataset source.')
      setTab('datasets')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const extras = { ...(hyper?.extras ?? {}), ...(hfModelId ? { hfModelId } : {}) }
      const job = await engineClient.finetune.create({
        name: jobName.trim() || `finetune-${modelId}`,
        modelId,
        modality,
        hyperparams: hyper ? { ...hyper, extras } : undefined,
        dataset: { sources, format: 'auto' },
        dryRun
      })
      setActiveJobId(job.id)
      await refreshJobs()
      setTab('jobs')
      if (!dryRun) {
        await engineClient.finetune.start(job.id)
        await refreshJobs()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runAgent = async (): Promise<void> => {
    const text = agentInput.trim()
    if (!text) return
    setAgentLog((l) => [...l, `You: ${text}`])
    setAgentInput('')
    setBusy(true)
    try {
      const res = await engineClient.agent.run({
        model: modelId || config.defaultModel,
        input: `${FINETUNE_AGENT_PROMPT}\n\nUser: ${text}\n\nContext: base model=${modelId}, modality=${modality}, dataset paths:\n${sources.join('\n')}, hfModelId=${hfModelId || '(not set)'}`,
        maxSteps: 8
      })
      setAgentLog((l) => [...l, `Agent: ${res.output}`])
      await refreshJobs()
    } catch (e) {
      setAgentLog((l) => [...l, `Error: ${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setBusy(false)
    }
  }

  const activeJob = jobs.find((j) => j.id === activeJobId) ?? jobs[0]

  const tabs: { id: FinetuneTab; label: string }[] = [
    { id: 'setup', label: 'Setup' },
    { id: 'datasets', label: 'Datasets' },
    { id: 'training', label: 'Training' },
    { id: 'jobs', label: `Jobs${jobs.length ? ` (${jobs.length})` : ''}` }
  ]

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-zinc-800 px-4 py-3">
          <h2 className="text-lg font-semibold text-indigo-300">Fine-tune</h2>
          <p className="text-xs text-zinc-500">
            LoRA / SFT — configure base model, manage datasets, tune hyperparameters, and monitor jobs.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  tab === t.id ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'setup' && (
            <div className="mx-auto max-w-3xl space-y-4">
              <CollapsibleSection title="Base model" defaultOpen subtitle={modelId || 'none'}>
                <div className="space-y-3">
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                  >
                    <option value="">Select model…</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                  {profile && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs text-zinc-400">
                      <p>
                        Architecture:{' '}
                        <span className="text-zinc-200">{profile.architecture ?? 'unknown'}</span>
                        {profile.parameterCount
                          ? ` · ~${(profile.parameterCount / 1e9).toFixed(1)}B params`
                          : ''}
                      </p>
                      <p className="mt-1">
                        Backend: <span className="text-zinc-200">{profile.trainerBackend}</span>
                        {profile.supportsTraining ? '' : ' · prepare-only'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(profile.suggestedModalities ?? []).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setModality(m)}
                            className={`rounded-full px-2 py-0.5 text-[10px] ${
                              modality === m
                                ? 'bg-indigo-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                      <ul className="mt-2 list-inside list-disc space-y-0.5">
                        {(profile.notes ?? []).map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <label className="block text-xs text-zinc-400">
                    HuggingFace weights ID (required when base is GGUF)
                    <input
                      value={hfModelId}
                      onChange={(e) => setHfModelId(e.target.value)}
                      placeholder="meta-llama/Llama-3.1-8B-Instruct"
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
                    />
                  </label>
                </div>
              </CollapsibleSection>

              <CollapsibleSection title="Task modality" defaultOpen>
                <div className="grid gap-2 sm:grid-cols-2">
                  {MODALITIES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModality(m.id)}
                      className={`rounded-xl border p-3 text-left transition ${
                        modality === m.id
                          ? 'border-indigo-500 bg-indigo-950/30'
                          : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                      }`}
                    >
                      <p className="text-sm font-medium text-zinc-200">{m.label}</p>
                      <p className="mt-1 text-[10px] text-zinc-500">{m.hint}</p>
                    </button>
                  ))}
                </div>
              </CollapsibleSection>

              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} />
                Agent-assisted setup (uses finetune_* tools)
              </label>
              {agentMode && (
                <div className="rounded-xl border border-indigo-900/50 bg-indigo-950/20 p-3">
                  <div
                    className="mb-2 max-h-40 overflow-y-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400"
                    ref={logRef}
                  >
                    {agentLog.length === 0 && <p className="text-zinc-600">Agent messages appear here…</p>}
                    {agentLog.map((line, i) => (
                      <p key={i} className="mb-1 whitespace-pre-wrap">
                        {line}
                      </p>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={agentInput}
                      onChange={(e) => setAgentInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void runAgent()
                        }
                      }}
                      placeholder="Ask the agent to prepare data or start a job…"
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runAgent()}
                      className="rounded-lg bg-indigo-600 px-4 py-2 text-sm"
                    >
                      Run
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'datasets' && (
            <div className="mx-auto max-w-4xl">
              <FinetuneDatasetManager
                modality={modality}
                sources={sourceList}
                onSourcesChange={setSourceList}
                onPreview={() => void prepare()}
                preview={preview}
                busy={busy}
              />
            </div>
          )}

          {tab === 'training' && (
            <div className="mx-auto max-w-3xl space-y-4">
              <label className="block text-xs text-zinc-400">
                Job name
                <input
                  value={jobName}
                  onChange={(e) => setJobName(e.target.value)}
                  placeholder={`finetune-${modelId || 'model'}`}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                />
              </label>

              {hyper ? (
                <CollapsibleSection title="Hyperparameters" defaultOpen>
                  <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                    {HYPER_FIELDS.map(({ key, label, step }) => (
                      <label key={key} className="text-xs text-zinc-400">
                        {label}
                        <input
                          type="number"
                          step={step ?? 1}
                          value={hyper[key] as number}
                          onChange={(e) =>
                            setHyper({ ...hyper, [key]: Number(e.target.value) })
                          }
                          className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
                        />
                      </label>
                    ))}
                  </div>
                  <label className="mt-3 block text-xs text-zinc-400">
                    Extra trainer options (JSON)
                    <textarea
                      value={JSON.stringify(hyper.extras ?? {}, null, 2)}
                      onChange={(e) => {
                        try {
                          setHyper({
                            ...hyper,
                            extras: JSON.parse(e.target.value) as Record<string, string | number | boolean>
                          })
                        } catch {
                          /* ignore */
                        }
                      }}
                      rows={4}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[10px]"
                    />
                  </label>
                </CollapsibleSection>
              ) : (
                <p className="text-sm text-zinc-500">Select a base model on Setup to load hyperparameters.</p>
              )}

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">
                <p>
                  <strong className="text-zinc-300">{sources.length}</strong> dataset source(s) · modality{' '}
                  <strong className="text-zinc-300">{modality}</strong> · model{' '}
                  <strong className="text-zinc-300">{modelId || '(none)'}</strong>
                </p>
                {sources.length === 0 && (
                  <button
                    type="button"
                    className="mt-2 text-indigo-400 hover:underline"
                    onClick={() => setTab('datasets')}
                  >
                    Add datasets →
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void createJob(true)}
                  className="rounded-lg border border-zinc-600 px-4 py-2 text-sm"
                >
                  Validate (dry run)
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void createJob(false)}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium disabled:opacity-40"
                >
                  {busy ? 'Working…' : 'Start fine-tune'}
                </button>
              </div>
            </div>
          )}

          {tab === 'jobs' && (
            <div className="mx-auto max-w-3xl space-y-3">
              {jobs.length === 0 ? (
                <p className="text-sm text-zinc-500">No jobs yet. Start training from the Training tab.</p>
              ) : (
                jobs.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setActiveJobId(j.id)}
                    className={`w-full rounded-xl border p-4 text-left ${
                      activeJobId === j.id
                        ? 'border-indigo-600 bg-indigo-950/30'
                        : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-zinc-200">{j.name}</p>
                      <span className="text-xs text-zinc-500">{j.status}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={`h-full ${j.status === 'failed' ? 'bg-rose-500' : 'bg-indigo-500'}`}
                        style={{ width: `${j.percent}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-zinc-500">{j.message}</p>
                  </button>
                ))
              )}
              {activeJob && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-4">
                  <h3 className="text-sm font-medium text-zinc-200">{activeJob.name}</h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    {activeJob.modality} · {activeJob.modelId}
                  </p>
                  <pre className="mt-3 max-h-56 overflow-y-auto text-[9px] text-zinc-500">
                    {(activeJob.log ?? []).slice(-60).join('\n')}
                  </pre>
                  {activeJob.status === 'running' && (
                    <button
                      type="button"
                      onClick={() => void engineClient.finetune.abort(activeJob.id).then(refreshJobs)}
                      className="mt-3 rounded-lg border border-rose-800 px-3 py-1.5 text-xs text-rose-300"
                    >
                      Stop job
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void engineClient.finetune.delete(activeJob.id).then(() => {
                        setActiveJobId(null)
                        return refreshJobs()
                      })
                    }
                    className="mt-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400"
                  >
                    Delete job record
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="mx-auto mt-4 max-w-3xl rounded-lg border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
