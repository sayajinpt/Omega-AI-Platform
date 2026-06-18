import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type {
  GpuDevice,
  ModelConfig,
  ModelInfo,
  OmegaConfig,
  SpeculativeDecodingConfig,
  SpeculativeType
} from '@omega/sdk'
import { engineClient } from '../lib/engine'
import { ContentStudioSettings } from '../components/ContentStudioSettings'
import { GpuAttentionSettingsBlock } from '../components/GpuAttentionSettings'
import { OmegaToolsSettingsBlock } from '../components/OmegaToolsSettings'
import { ThemeSettings } from '../components/ThemeSettings'
import { SidecarEnginesSettings } from '../components/SidecarEnginesSettings'
import { SysInfoSettings } from '../components/SysInfoSettings'
import { BRAND_NAME } from '../../../shared/brand'
import { DEFAULT_OMEGA_SYSTEM_PROMPT } from '../../../shared/assistant-prompt'
import type { IntegrationsConfig, UpdaterStatus } from '@omega/sdk'

const POLL_INTERVALS = [
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 }
] as const

const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'performance', label: 'Performance' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'tools', label: 'Tools' },
  { id: 'office', label: 'Office' },
  { id: 'updates', label: 'Updates' },
  { id: 'sysinfo', label: 'Sys info' }
] as const

type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

function SettingsTabBar({
  active,
  onChange
}: {
  active: SettingsTabId
  onChange: (id: SettingsTabId) => void
}) {
  return (
    <nav
      className="mb-6 flex flex-wrap gap-2 border-b border-zinc-800 pb-4"
      aria-label="Settings sections"
    >
      {SETTINGS_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-lg px-3 py-1.5 text-sm transition ${
            active === t.id
              ? 'bg-indigo-600 text-white'
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}

function SettingsPanel({
  id,
  active,
  children
}: {
  id: SettingsTabId
  active: SettingsTabId
  children: ReactNode
}) {
  if (active !== id) return null
  return (
    <div role="tabpanel" className="space-y-2">
      {children}
    </div>
  )
}

function OfficePollingSettings() {
  const [poll, setPoll] = useState<{ enabled: boolean; intervalMs: number } | null>(null)
  useEffect(() => {
    void engineClient.office.snapshot().then((s) => setPoll(s.poll))
  }, [])
  if (!poll) return <p className="text-sm text-zinc-500">Loading…</p>
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-500">Auto-refresh GitHub PR and Jira monitors on the Office page.</p>
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={poll.enabled}
          onChange={(e) => {
            const enabled = e.target.checked
            void engineClient.office.pollSet(enabled, poll.intervalMs).then((s) => setPoll(s.poll))
          }}
        />
        Enable monitor polling
      </label>
      <label className="block text-xs text-zinc-400">
        Interval
        <select
          value={poll.intervalMs}
          disabled={!poll.enabled}
          onChange={(e) => {
            const intervalMs = Number(e.target.value)
            void engineClient.office.pollSet(poll.enabled, intervalMs).then((s) => setPoll(s.poll))
          }}
          className="mt-1 block w-full max-w-xs rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm disabled:opacity-40"
        >
          {POLL_INTERVALS.map((o) => (
            <option key={o.ms} value={o.ms}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function IntegrationsSettings() {
  const [cfg, setCfg] = useState<IntegrationsConfig>({})
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    void engineClient.integrations.get().then(setCfg)
  }, [])
  const save = async () => {
    await engineClient.integrations.set(cfg)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-500">Tokens for Office monitors (GitHub PR, Jira). Also read from env vars.</p>
      <label className="block text-xs text-zinc-400">
        GitHub token
        <input
          type="password"
          value={cfg.github?.token ?? ''}
          onChange={(e) =>
            setCfg({ ...cfg, github: { ...cfg.github, token: e.target.value } })
          }
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          placeholder="ghp_…"
        />
      </label>
      <label className="block text-xs text-zinc-400">
        Jira base URL
        <input
          value={cfg.jira?.baseUrl ?? ''}
          onChange={(e) =>
            setCfg({ ...cfg, jira: { ...cfg.jira, baseUrl: e.target.value } })
          }
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          placeholder="https://yourorg.atlassian.net"
        />
      </label>
      <label className="block text-xs text-zinc-400">
        Jira email
        <input
          value={cfg.jira?.email ?? ''}
          onChange={(e) => setCfg({ ...cfg, jira: { ...cfg.jira, email: e.target.value } })}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
        />
      </label>
      <label className="block text-xs text-zinc-400">
        Jira API token
        <input
          type="password"
          value={cfg.jira?.apiToken ?? ''}
          onChange={(e) =>
            setCfg({ ...cfg, jira: { ...cfg.jira, apiToken: e.target.value } })
          }
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={() => void save()}
        className="rounded bg-indigo-600 px-3 py-1 text-xs text-white"
      >
        Save integrations
      </button>
      {saved && <span className="text-xs text-emerald-400">Saved</span>}
    </div>
  )
}

function UpdaterSettings() {
  const [st, setSt] = useState<UpdaterStatus | null>(null)
  useEffect(() => {
    engineClient.updater.status().then(setSt)
    return engineClient.updater.onStatus(setSt)
  }, [])
  return (
    <div className="space-y-2 text-sm">
      <p className="text-zinc-500">Check for app updates (packaged installs).</p>
      {st?.message && <p className="text-xs text-zinc-400">{st.message}</p>}
      {st?.error && <p className="text-xs text-red-400">{st.error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded border border-zinc-600 px-3 py-1 text-xs"
          onClick={() => void engineClient.updater.check().then(setSt)}
        >
          Check for updates
        </button>
        {st?.available && (
          <button
            type="button"
            className="rounded bg-indigo-600 px-3 py-1 text-xs text-white"
            onClick={() => void engineClient.updater.install()}
          >
            Install {st.version}
          </button>
        )}
      </div>
    </div>
  )
}

export function SettingsPage({
  config,
  models,
  onSaved
}: {
  config: OmegaConfig
  models: ModelInfo[]
  onSaved: (c: OmegaConfig) => void
}) {
  const [draft, setDraft] = useState(config)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [inferStatus, setInferStatus] = useState('')
  const [gpus, setGpus] = useState<GpuDevice[]>([])
  const [modelId, setModelId] = useState(config.defaultModel || models[0]?.id || '')
  const [mcfg, setMcfg] = useState<ModelConfig | null>(null)
  const [activeTab, setActiveTab] = useState<SettingsTabId>('general')

  const specGlobal: SpeculativeDecodingConfig = draft.speculativeDecoding ?? {
    enabled: false,
    types: ['draft-mtp'],
    nMax: 2,
    nMin: 0
  }
  const setSpecGlobal = (patch: Partial<SpeculativeDecodingConfig>) =>
    setDraft({
      ...draft,
      speculativeDecoding: { ...specGlobal, ...patch }
    })
  const toggleSpecType = (
    cfg: SpeculativeDecodingConfig,
    type: SpeculativeType,
    on: boolean,
    apply: (next: SpeculativeDecodingConfig) => void
  ) => {
    const cur = new Set(cfg.types ?? ['draft-mtp'])
    if (on) cur.add(type)
    else cur.delete(type)
    const types = [...cur].filter((t) => t !== 'none') as SpeculativeType[]
    apply({ ...cfg, types: types.length ? types : ['draft-mtp'] })
  }

  useEffect(() => {
    setDraft(config)
  }, [config])

  useEffect(() => {
    engineClient.runtime.status().then((s) => {
      setInferStatus(`runtime=${s.state} · inference=${s.inference ?? '?'} · model=${s.activeModel || 'none'}`)
    })
    engineClient.gpu
      .list()
      .then((g) => setGpus(Array.isArray(g) ? g : []))
      .catch(() => setGpus([]))
    return undefined
  }, [])

  const loadModelCfg = useCallback(async (id: string) => {
    if (!id) {
      setMcfg(null)
      return
    }
    setMcfg(await engineClient.modelConfig.get(id))
  }, [])

  useEffect(() => {
    loadModelCfg(modelId)
  }, [modelId, loadModelCfg])

  const save = async () => {
    setSaveStatus('saving')
    setSaveError(null)
    try {
      const next = await engineClient.config.set(draft)
      setDraft(next)
      if (draft.defaultModel?.trim()) {
        try {
          await engineClient.inference.switch(draft.defaultModel.trim())
        } catch (e) {
          console.warn('inference.switch after save:', e)
        }
      }
      onSaved(next)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSaveError(msg)
      setSaveStatus('error')
    }
  }

  const saveModelCfg = async () => {
    if (!modelId || !mcfg) return
    const saved = await engineClient.modelConfig.set(modelId, mcfg)
    setMcfg(saved)
  }

  const trusted = draft.trustedTools ?? []
  const toggleTrust = (tool: string) => {
    const next = trusted.includes(tool) ? trusted.filter((t) => t !== tool) : [...trusted, tool]
    setDraft({ ...draft, trustedTools: next })
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Settings</h2>
        <button
          type="button"
          disabled={saveStatus === 'saving'}
          onClick={() => void save()}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {saveStatus === 'saving' ? 'Saving…' : 'Save all settings'}
        </button>
        {saveStatus === 'saved' && <span className="text-xs text-emerald-400">Saved</span>}
        {saveStatus === 'error' && saveError && (
          <span className="text-xs text-rose-400">{saveError}</span>
        )}
      </div>
      {inferStatus && <p className="mb-4 text-xs text-zinc-500">{inferStatus}</p>}

      <div className="mx-auto max-w-3xl">
        <SettingsTabBar active={activeTab} onChange={setActiveTab} />

        <SettingsPanel id="general" active={activeTab}>
          <section className="mb-6 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Theme</h3>
            <ThemeSettings draft={draft} setDraft={setDraft} />
          </section>

          <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">General</h3>
          <div className="space-y-4">
          <label className="block text-sm">
            <span className="text-zinc-400">Default model</span>
            <select
              value={draft.defaultModel}
              onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
            >
              <option value="">(none)</option>
              {models.map((m) => (
                <option key={m.id}>{m.id}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Max context tokens (global trim)</span>
            <input
              type="number"
              value={draft.maxContextTokens}
              onChange={(e) => setDraft({ ...draft, maxContextTokens: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">API port (OpenAI-compatible)</span>
            <input
              type="number"
              value={draft.runtimePort}
              onChange={(e) => setDraft({ ...draft, runtimePort: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Models directory</span>
            <input
              value={draft.modelsDir}
              readOnly
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-500"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Default chat / session preferences</span>
            <p className="mt-0.5 text-xs text-zinc-500">
              In agent mode, {BRAND_NAME} uses the full Assistant prompt (media, browser, tools) from{' '}
              <code className="text-zinc-400">shared/assistant-prompt.ts</code> plus this text as user
              preferences.
            </p>
            <textarea
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              rows={4}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
            />
            <button
              type="button"
              className="mt-1 text-xs text-indigo-400 hover:underline"
              onClick={() => setDraft({ ...draft, systemPrompt: DEFAULT_OMEGA_SYSTEM_PROMPT })}
            >
              Reset to default preferences
            </button>
          </label>
          <button type="button" onClick={() => void save()} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium">
            Save general
          </button>
          </div>
          </section>
        </SettingsPanel>

        <SettingsPanel id="performance" active={activeTab}>
          <section className="mb-6 space-y-4 rounded-lg border border-indigo-900/40 bg-indigo-950/20 p-4">
            <h3 className="text-sm font-semibold text-zinc-200">UI performance preset</h3>
            <p className="text-sm text-zinc-400">
              Keeps chat and the app snappier: shorter default replies, slightly smaller context window,
              fewer agent tool rounds. Does not disable tools or features.
            </p>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={draft.performanceMode === true}
                onChange={(e) => {
                  const on = e.target.checked
                  setDraft({
                    ...draft,
                    performanceMode: on,
                    maxContextTokens: on ? 6144 : 8192,
                    chat: {
                      ...draft.chat,
                      maxTokens: on ? 2048 : 4096,
                      maxAttachmentMb: draft.chat?.maxAttachmentMb ?? 25,
                      maxAttachments: draft.chat?.maxAttachments ?? 8
                    }
                  })
                }}
                className="mt-0.5 h-4 w-4 rounded border-zinc-600"
              />
              <span>
                <span className="text-zinc-200">Enable performance mode</span>
                <span className="mt-1 block text-xs text-zinc-500">
                  Chat max tokens: {draft.chat?.maxTokens ?? 4096} · Context cap:{' '}
                  {draft.maxContextTokens.toLocaleString()}
                </span>
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-zinc-400">Chat max tokens (override)</span>
              <input
                type="number"
                min={128}
                max={16384}
                step={128}
                value={draft.chat?.maxTokens ?? 4096}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    chat: {
                      ...draft.chat,
                      maxTokens: Math.max(512, Math.min(16384, Number(e.target.value) || 4096)),
                      maxAttachmentMb: draft.chat?.maxAttachmentMb ?? 25,
                      maxAttachments: draft.chat?.maxAttachments ?? 8
                    }
                  })
                }
                className="mt-1 w-full max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
              />
            </label>
          </section>

          <section className="mb-6 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Bundled Ollama engine (omega-ollama)</h3>
            <p className="text-sm text-zinc-400">
              Omega ships a private Ollama runtime for safetensors, AWQ, GPTQ, and Ollama-native models on{' '}
              <code className="text-zinc-300">127.0.0.1</code> only. By default it does not contact{' '}
              <code className="text-zinc-300">ollama.com</code> or run cloud-hosted models.
            </p>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={draft.ollamaCloudEnabled === true}
                onChange={(e) =>
                  setDraft({ ...draft, ollamaCloudEnabled: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-zinc-600"
              />
              <span>
                <span className="text-zinc-200">Enable Ollama cloud models</span>
                <span className="mt-1 block text-xs text-zinc-500">
                  Allows remote inference and catalog sync via ollama.com (requires network). The engine
                  restarts when you save. Use <code className="text-zinc-400">ollama:&lt;name&gt;</code>{' '}
                  models or pull cloud models from Engines → Ollama library.
                </span>
              </span>
            </label>
          </section>

          <section className="mb-6 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Optional inference engines (EXL2 / ONNX)</h3>
            <SidecarEnginesSettings />
          </section>

          <section className="mb-6 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Model tuning</h3>
            <p className="text-sm text-zinc-400">
              Adjust GPU layers, context size, and presets per model in Model Studio.
            </p>
          </section>

          <GpuAttentionSettingsBlock draft={draft} setDraft={setDraft} />

          <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Hardware & per-model</h3>
          <div className="space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs">
            <p className="mb-2 text-zinc-400">Detected devices:</p>
            {gpus.length === 0 ? (
              <p className="text-zinc-500">probing…</p>
            ) : (
              <ul className="space-y-1">
                {gpus.map((g, i) => (
                  <li key={`${g.kind}-${i}`} className="flex justify-between">
                    <span>
                      <span className="text-indigo-300">{g.kind.toUpperCase()}</span>{' '}
                      <span className="text-zinc-300">{g.name}</span>
                    </span>
                    {g.memory_mb !== undefined && (
                      <span className="text-zinc-500">{(g.memory_mb / 1024).toFixed(1)} GB</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={async () => setGpus(await engineClient.gpu.list(true))}
              className="mt-2 text-xs text-indigo-400 hover:underline"
            >
              Re-probe
            </button>
          </div>

          <label className="block text-sm">
            <span className="text-zinc-400">Global GPU layers default</span>
            <input
              type="number"
              min={0}
              value={draft.gpuLayers ?? 35}
              onChange={(e) => setDraft({ ...draft, gpuLayers: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
            />
          </label>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
            <p className="text-xs font-semibold uppercase text-zinc-500">Speculative decoding (default)</p>
            <p className="text-xs text-zinc-500">
              Multi-token prediction (draft-mtp) uses omega-engine with bundled omega-infer when enabled.
              draft-simple uses a separate draft GGUF in the native engine.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={specGlobal.enabled ?? false}
                onChange={(e) => setSpecGlobal({ enabled: e.target.checked })}
              />
              Enable speculative decoding
            </label>
            {specGlobal.enabled && (
              <>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(specGlobal.types ?? ['draft-mtp']).includes('draft-mtp')}
                      onChange={(e) =>
                        toggleSpecType(specGlobal, 'draft-mtp', e.target.checked, setSpecGlobal)
                      }
                    />
                    draft-mtp (MTP)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(specGlobal.types ?? []).includes('draft-simple')}
                      onChange={(e) =>
                        toggleSpecType(specGlobal, 'draft-simple', e.target.checked, setSpecGlobal)
                      }
                    />
                    draft-simple
                  </label>
                </div>
                <p className="text-[11px] text-zinc-500">
                  MTP bench (e.g. RTX 4070): <strong className="text-zinc-400">n-max = 2</strong> gives the
                  best speed and acceptance. Values above 3 often lower throughput; Omega caps manual n-max
                  at 5.
                </p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <label>
                    <span className="text-zinc-400">Max draft tokens (n-max)</span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={specGlobal.nMax ?? 2}
                      onChange={(e) => {
                        const n = Math.min(5, Math.max(1, Number(e.target.value) || 2))
                        setSpecGlobal({ nMax: n })
                      }}
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                    />
                  </label>
                  <label>
                    <span className="text-zinc-400">Min draft tokens (n-min)</span>
                    <input
                      type="number"
                      min={0}
                      max={2}
                      value={specGlobal.nMin ?? 0}
                      onChange={(e) => {
                        const n = Math.min(2, Math.max(0, Number(e.target.value)))
                        setSpecGlobal({ nMin: n })
                      }}
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                    />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="text-zinc-400">Draft model path (optional)</span>
                  <input
                    value={specGlobal.draftModelPath ?? ''}
                    onChange={(e) => setSpecGlobal({ draftModelPath: e.target.value })}
                    placeholder="Leave empty to use main GGUF (MTP)"
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs"
                  />
                </label>
              </>
            )}
          </div>

          <p className="text-xs font-semibold uppercase text-zinc-500">Per-model config</p>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            {models.map((m) => (
              <option key={m.id}>{m.id}</option>
            ))}
          </select>
          {mcfg && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <label>
                <span className="text-zinc-400">Context size</span>
                <input
                  type="number"
                  value={mcfg.contextSize}
                  onChange={(e) => setMcfg({ ...mcfg, contextSize: Number(e.target.value) })}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                />
              </label>
              <label>
                <span className="text-zinc-400">GPU layers</span>
                <input
                  type="number"
                  value={mcfg.gpuLayers}
                  onChange={(e) => setMcfg({ ...mcfg, gpuLayers: Number(e.target.value) })}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                />
              </label>
              <label className="col-span-2">
                <span className="text-zinc-400">Chat attention backend</span>
                <select
                  value={
                    mcfg.attentionMode ??
                    (mcfg.flashAttention === true
                      ? 'flash'
                      : mcfg.flashAttention === false
                        ? 'off'
                        : '')
                  }
                  onChange={(e) => {
                    const v = e.target.value
                    if (!v) {
                      const { attentionMode: _a, flashAttention: _f, ...rest } = mcfg
                      setMcfg(rest)
                      return
                    }
                    setMcfg({
                      ...mcfg,
                      attentionMode: v as 'auto' | 'flash' | 'off',
                      flashAttention: undefined
                    })
                  }}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                >
                  <option value="">Inherit (Settings → Performance)</option>
                  <option value="auto">Auto</option>
                  <option value="flash">Flash attention</option>
                  <option value="off">Off</option>
                </select>
                <span className="block text-xs text-zinc-500 mt-1">
                  Per-model override for llama.cpp flash-attn
                </span>
              </label>
              <label className="col-span-2">
                <span className="text-zinc-400">System prompt override</span>
                <textarea
                  value={mcfg.systemPrompt ?? ''}
                  onChange={(e) => setMcfg({ ...mcfg, systemPrompt: e.target.value })}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                />
              </label>
              <div className="col-span-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
                <p className="text-xs font-semibold text-zinc-500">Per-model speculative override</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={mcfg.speculative?.enabled ?? specGlobal.enabled ?? false}
                    onChange={(e) =>
                      setMcfg({
                        ...mcfg,
                        speculative: {
                          ...(mcfg.speculative ?? specGlobal),
                          enabled: e.target.checked
                        }
                      })
                    }
                  />
                  Enable for this model
                </label>
                {(mcfg.speculative?.enabled ?? specGlobal.enabled) && (
                  <label className="block text-sm">
                    <span className="text-zinc-400">Draft model path override</span>
                    <input
                      value={mcfg.speculative?.draftModelPath ?? ''}
                      onChange={(e) =>
                        setMcfg({
                          ...mcfg,
                          speculative: {
                            ...(mcfg.speculative ?? specGlobal),
                            draftModelPath: e.target.value
                          }
                        })
                      }
                      placeholder="Inherit global default"
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs"
                    />
                  </label>
                )}
              </div>
              <button
                type="button"
                onClick={saveModelCfg}
                className="col-span-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium"
              >
                Save model config
              </button>
            </div>
          )}
          </div>
          </section>
        </SettingsPanel>

        <SettingsPanel id="permissions" active={activeTab}>
          <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Permissions & privacy</h3>
          <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowWebFetch}
              onChange={(e) => setDraft({ ...draft, allowWebFetch: e.target.checked })}
            />
            Allow web fetch tools
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowBrowser ?? false}
              onChange={(e) => setDraft({ ...draft, allowBrowser: e.target.checked })}
            />
            Browser automation (Browser tab + browser_navigate / snapshot / stealth tools)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.selfImproveEnabled !== false}
              onChange={(e) => setDraft({ ...draft, selfImproveEnabled: e.target.checked })}
            />
            Learn from chats (self-improve reflection after each session)
          </label>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <p className="mb-2 text-sm font-medium text-zinc-300">Memory janitor</p>
            <p className="mb-3 text-[10px] text-zinc-500">
              Used by /janitor and automatic memory cleanup after new facts are saved.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-zinc-400">
                Trim session when messages exceed
                <input
                  type="number"
                  min={10}
                  value={draft.memoryJanitor?.maxSessionMessages ?? 30}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      memoryJanitor: {
                        ...draft.memoryJanitor,
                        maxSessionMessages: Number(e.target.value) || 30
                      }
                    })
                  }
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Keep last N messages
                <input
                  type="number"
                  min={4}
                  value={draft.memoryJanitor?.keepSessionMessages ?? 20}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      memoryJanitor: {
                        ...draft.memoryJanitor,
                        keepSessionMessages: Number(e.target.value) || 20
                      }
                    })
                  }
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Max memory entries (0 = off)
                <input
                  type="number"
                  min={0}
                  value={draft.memoryJanitor?.maxMemoryEntries ?? 500}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      memoryJanitor: {
                        ...draft.memoryJanitor,
                        maxMemoryEntries: Number(e.target.value)
                      }
                    })
                  }
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Drop memory older than (days, 0 = off)
                <input
                  type="number"
                  min={0}
                  value={draft.memoryJanitor?.maxMemoryAgeDays ?? 0}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      memoryJanitor: {
                        ...draft.memoryJanitor,
                        maxMemoryAgeDays: Number(e.target.value)
                      }
                    })
                  }
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
              </label>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowFinetune !== false}
              onChange={(e) => setDraft({ ...draft, allowFinetune: e.target.checked })}
            />
            Fine-tune jobs (Fine-tune tab + finetune_* agent tools)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowHostFilesystem === true}
              onChange={(e) => setDraft({ ...draft, allowHostFilesystem: e.target.checked })}
            />
            Host filesystem access (read/write files anywhere on your PC via absolute paths)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowShell}
              onChange={(e) => setDraft({ ...draft, allowShell: e.target.checked })}
            />
            Allow shell tool (run_shell / run_process on your system)
          </label>
          <div>
            <p className="mb-1 text-sm text-zinc-400">Approval mode</p>
            <select
              value={draft.approvalMode ?? 'smart'}
              onChange={(e) =>
                setDraft({ ...draft, approvalMode: e.target.value as 'smart' | 'always' | 'off' })
              }
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
            >
              <option value="smart">Smart — prompt only for sensitive tools or dangerous patterns</option>
              <option value="always">Always — prompt for every tool</option>
              <option value="off">Off — only prompt for hard-coded destructive patterns</option>
            </select>
          </div>
          <div>
            <p className="mb-1 text-sm text-zinc-400">Language</p>
            <select
              value={localStorage.getItem('omega.locale') ?? 'en'}
              onChange={(e) => {
                localStorage.setItem('omega.locale', e.target.value)
                window.location.reload()
              }}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="pt-BR">Português (BR)</option>
              <option value="zh-CN">简体中文</option>
              <option value="ja">日本語</option>
              <option value="fr">Français</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.avatarEnabled !== false}
              onChange={(e) => setDraft({ ...draft, avatarEnabled: e.target.checked })}
            />
            Companion (floating 3D avatar)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.showMenuBar !== false}
              onChange={(e) => setDraft({ ...draft, showMenuBar: e.target.checked })}
            />
            Show menu bar (File, Edit, View…)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.closeToTray !== false}
              onChange={(e) => setDraft({ ...draft, closeToTray: e.target.checked })}
            />
            Minimize to tray when closing the window
          </label>
          {draft.closeToTray !== false ? (
            <p className="text-[11px] text-zinc-500">
              The <span className="text-indigo-300">×</span> button hides Omega in the system tray; use tray → Quit Omega to
              exit fully. This avoids the app looking &quot;closed&quot; after idle when you only dismissed the window.
            </p>
          ) : null}
          {draft.avatarEnabled !== false ? (
            <p className="text-[11px] text-zinc-500">
              Uncheck the box above to turn off the companion completely. The companion{' '}
              <span className="text-indigo-300">×</span> button only hides it until you show it again from the top bar.
              Use <span className="text-indigo-300">Detach</span> to keep it on the desktop while Omega is minimized.
            </p>
          ) : (
            <p className="text-[11px] text-zinc-500">
              Enable the companion to see the floating 3D avatar and live context token counter on chat.
            </p>
          )}
          <div>
            <p className="mb-1 text-sm text-zinc-400">HuggingFace token</p>
            <input
              type="password"
              placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
              spellCheck={false}
              value={(draft as { hfToken?: string }).hfToken ?? ''}
              onChange={(e) => setDraft({ ...draft, hfToken: e.target.value } as typeof draft)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              Required for gated models (Llama, Gemma, some Mistral / Qwen). Generate a
              read-only token at{' '}
              <a
                href="https://huggingface.co/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:underline"
              >
                huggingface.co/settings/tokens
              </a>
              . Stored locally only.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.autoApproveTools}
              onChange={(e) => setDraft({ ...draft, autoApproveTools: e.target.checked })}
            />
            Auto-approve every tool (no prompts — overrides above)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.autoApproveSelfExtension === true}
              onChange={(e) =>
                setDraft({ ...draft, autoApproveSelfExtension: e.target.checked })
              }
            />
            Auto-approve agent self-extension (plugins &amp; skills)
          </label>
          <p className="text-[11px] text-zinc-500">
            When off, the agent must get your approval in chat before installing plugins, writing
            plugin code, or creating skills. Does not affect other tools unless auto-approve all is
            on.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.autoApproveCapabilities === true}
              onChange={(e) =>
                setDraft({ ...draft, autoApproveCapabilities: e.target.checked })
              }
            />
            Auto-approve permissions (web fetch, browser, shell, etc.)
          </label>
          <p className="text-[11px] text-zinc-500">
            When off, if the agent needs a permission you turned off, a card appears in chat to
            allow it for that action (same as onboarding toggles).
          </p>

          <div>
            <p className="mb-1 text-sm text-zinc-400">Trusted tools (skip approval):</p>
            <div className="flex flex-wrap gap-2">
              {[
                'datetime',
                'math',
                'system_info',
                'clipboard_read',
                'clipboard_write',
                'web_fetch',
                'http_request',
                'run_shell',
                'run_process',
                'read_file',
                'write_file',
                'list_dir'
              ].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTrust(t)}
                  className={`rounded-full border px-3 py-0.5 text-xs ${
                    trusted.includes(t)
                      ? 'border-emerald-600 bg-emerald-900/30 text-emerald-300'
                      : 'border-zinc-700 text-zinc-400'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <button type="button" onClick={() => void save()} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium">
            Save permissions
          </button>
          </div>
          </section>
        </SettingsPanel>

        <SettingsPanel id="tools" active={activeTab}>
          <section className="mb-6 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">{BRAND_NAME} tools</h3>
          <OmegaToolsSettingsBlock
            config={draft}
            models={models}
            onSave={async (patch) => {
              const next = await engineClient.config.set({ ...draft, ...patch })
              setDraft(next)
              onSaved(next)
            }}
          />
          </section>

          {draft.allowContentStudio !== false && (
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
              <ContentStudioSettings />
            </section>
          )}
        </SettingsPanel>

        <SettingsPanel id="office" active={activeTab}>
          <section className="mb-6 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Office monitors</h3>
            <OfficePollingSettings />
          </section>
          <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Integrations</h3>
            <IntegrationsSettings />
          </section>
        </SettingsPanel>

        <SettingsPanel id="updates" active={activeTab}>
          <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">App updates</h3>
            <UpdaterSettings />
          </section>
        </SettingsPanel>

        <SettingsPanel id="sysinfo" active={activeTab}>
          <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">System information</h3>
            <p className="text-sm text-zinc-500">
              Hardware, inference backends (CUDA, Vulkan, Metal, CPU), and status of runtime services.
            </p>
            <SysInfoSettings />
          </section>
        </SettingsPanel>
      </div>
    </div>
  )
}
