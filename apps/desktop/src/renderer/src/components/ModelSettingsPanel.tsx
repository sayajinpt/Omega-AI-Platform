import { useCallback, useEffect, useState } from 'react'
import type {
  GpuAttentionMode,
  GpuDevice,
  MemoryEstimate,
  ModelConfig,
  ModelMetadata,
  SpeculativeDecodingConfig
} from '@omega/sdk'
import { engineClient } from '../lib/engine'
import {
  MTP_DRAFT_NMAX_ABSOLUTE,
  MTP_DRAFT_NMAX_DEFAULT,
  MTP_DRAFT_NMIN_ABSOLUTE,
  clampMtpDraftLimits
} from '../../../shared/mtp-draft-limits'
import { Select, Slider, Toggle } from './Slider'
import { CollapsibleSection } from './CollapsibleSection'
import { HfAdapterPanel } from './HfAdapterPanel'

const CTX_PRESETS = [
  { label: '2K', value: 2048 },
  { label: '4K', value: 4096 },
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 }
]

const CACHE_OPTS: Array<{ value: 'f32' | 'f16' | 'q8_0' | 'q4_0'; label: string }> = [
  { value: 'f32', label: 'F32 (highest quality)' },
  { value: 'f16', label: 'F16 (default)' },
  { value: 'q8_0', label: 'Q8_0 (~50% VRAM)' },
  { value: 'q4_0', label: 'Q4_0 (~25% VRAM)' }
]

const ATTENTION_OPTS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Inherit (Settings → Performance)' },
  { value: 'auto', label: 'Auto' },
  { value: 'flash', label: 'Flash attention' },
  { value: 'off', label: 'Off' }
]

function modelAttentionSelectValue(cfg: ModelConfig): string {
  if (cfg.attentionMode) return cfg.attentionMode
  if (cfg.flashAttention === true) return 'flash'
  if (cfg.flashAttention === false) return 'off'
  return ''
}

function mb(v: number): string {
  if (v < 1024) return `${v} MB`
  return `${(v / 1024).toFixed(2)} GB`
}

function backendLabel(
  backends: Array<{ backend: string; available: boolean }>,
  id: string
): string {
  const b = backends.find((x) => x.backend === id)
  if (!b) return ''
  return b.available ? '' : ' — not in this build'
}

export function ModelSettingsPanel({
  modelId,
  supportsMtp = false,
  onClose,
  onSaved,
  embedded = false,
  isLoaded = false,
  isDefault = false,
  loadBusy = false,
  onLoad,
  onUnload
}: {
  modelId: string
  /** From model scan — filename/tag suggests MTP weights. */
  supportsMtp?: boolean
  onClose?: () => void
  onSaved?: () => void
  /** When true, renders inline (no modal overlay). */
  embedded?: boolean
  isLoaded?: boolean
  isDefault?: boolean
  loadBusy?: boolean
  onLoad?: () => void
  onUnload?: () => void
}) {
  const [cfg, setCfg] = useState<ModelConfig | null>(null)
  const [meta, setMeta] = useState<ModelMetadata | null>(null)
  const [estimate, setEstimate] = useState<MemoryEstimate | null>(null)
  const [gpus, setGpus] = useState<GpuDevice[]>([])
  const [backends, setBackends] = useState<
    Array<{ backend: 'cuda' | 'vulkan' | 'metal' | 'cpu'; available: boolean; error?: string }>
  >([])
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [presets, setPresets] = useState<Array<{ id: string; label: string; description: string }>>([])
  const [selectedPreset, setSelectedPreset] = useState('')

  useEffect(() => {
    void (async () => {
      setBusy(true)
      try {
        const [c, m, g, b] = await Promise.all([
          engineClient.modelConfig.get(modelId),
          engineClient.modelMeta.inspect(modelId).catch(() => null),
          engineClient.gpu.list().catch(() => []),
          engineClient.inference.backends().catch(() => [])
        ])
        const p = await engineClient.modelPresets.list().catch(() => [])
        setCfg(c)
        setMeta(m)
        setGpus(Array.isArray(g) ? g : [])
        setBackends(Array.isArray(b) ? b : [])
        const presetRows = Array.isArray(p) ? p : []
        setPresets(presetRows.map((x) => ({ id: x.id, label: x.label, description: x.description })))
        setSelectedPreset(presetRows[0]?.id ?? '')
      } finally {
        setBusy(false)
      }
    })()
  }, [modelId])

  const gpuList = Array.isArray(gpus) ? gpus : []
  const gpuTotalMb = gpuList.reduce((acc, g) => acc + (g.kind !== 'cpu' ? g.memory_mb ?? 0 : 0), 0)
  const gpuDevices = gpuList.filter((g) => g.kind !== 'cpu')
  const vendorKinds = new Set(gpuDevices.map((g) => g.kind))
  const isMixedVendor = vendorKinds.size > 1
  const hasMultiGpu = gpuDevices.length > 1

  const refreshEstimate = useCallback(
    async (next: ModelConfig) => {
      try {
        setEstimate(await engineClient.modelMeta.estimate(modelId, next, gpuTotalMb || undefined))
      } catch {
        /* meta unavailable */
      }
    },
    [modelId, gpuTotalMb]
  )

  useEffect(() => {
    if (cfg) void refreshEstimate(cfg)
  }, [cfg, refreshEstimate])


  if (busy || !cfg) {
    const loading = <p className="text-sm text-zinc-400">Loading model settings…</p>
    if (embedded) return <div className="flex h-full items-center justify-center p-6">{loading}</div>
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6">{loading}</div>
    )
  }

  const totalLayers = meta?.totalLayers ?? 32
  const sliderMaxLayers = totalLayers + 1 // +1 for output
  const effectiveGpuLayers = Math.min(cfg.gpuLayers, sliderMaxLayers)
  const ctxMax = meta?.contextLengthMax ?? 32768

  const save = async () => {
    setSaving(true)
    try {
      const saved = await engineClient.modelConfig.set(modelId, {
        ...cfg
      })
      setCfg(saved)
      onSaved?.()
      onClose?.()
    } finally {
      setSaving(false)
    }
  }

  const aside = (
      <aside
        className={`flex h-full flex-col overflow-hidden bg-zinc-950 ${
          embedded ? 'w-full' : 'w-full max-w-2xl border-l border-zinc-800 shadow-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-800 px-6 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-zinc-500">Model configuration</p>
              <h2 className="text-lg font-semibold text-indigo-300">{modelId}</h2>
              {meta && (
                <p className="mt-1 text-xs text-zinc-500">
                  {meta.architecture ?? 'unknown arch'} · {meta.totalLayers ?? '?'} layers · ctx max{' '}
                  {meta.contextLengthMax?.toLocaleString() ?? '?'} · {mb(meta.fileSize / 1024 ** 2)}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {onLoad && (
                <button
                  type="button"
                  disabled={loadBusy || isLoaded}
                  onClick={onLoad}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                >
                  {isLoaded ? 'Loaded' : loadBusy ? 'Loading…' : 'Load'}
                </button>
              )}
              {onUnload && (
                <button
                  type="button"
                  disabled={loadBusy || !isLoaded}
                  onClick={onUnload}
                  className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  Unload
                </button>
              )}
              {isDefault && (
                <span className="rounded bg-indigo-900/50 px-2 py-1 text-[10px] text-indigo-200">default</span>
              )}
              {isLoaded && (
                <span className="rounded bg-emerald-900/50 px-2 py-1 text-[10px] text-emerald-300">in memory</span>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <CollapsibleSection title="Load strategy" defaultOpen>
            <div className="space-y-3">
              <p className="text-[11px] text-zinc-400">Manual model tuning. Apply a preset or adjust sliders.</p>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <select
                  value={selectedPreset}
                  onChange={(e) => setSelectedPreset(e.target.value)}
                  className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!selectedPreset}
                  onClick={async () => {
                    const next = await engineClient.modelPresets.apply(modelId, selectedPreset)
                    setCfg(next)
                  }}
                  className="rounded border border-indigo-700 px-2 py-1 text-xs text-indigo-200"
                >
                  Apply preset
                </button>
              </div>
            </div>
          </CollapsibleSection>

          {/* Memory estimate */}
          {estimate && (
            <CollapsibleSection title="Estimated memory" defaultOpen>
              <MemoryBar estimate={estimate} gpuTotalMb={gpuTotalMb || undefined} />
            </CollapsibleSection>
          )}

          <CollapsibleSection
            title="Hardware offload"
            defaultOpen
          >
            <div className="space-y-4">
            <Slider
              label={`GPU offload (${effectiveGpuLayers} / ${sliderMaxLayers} layers on GPU)`}
              hint={
                effectiveGpuLayers >= sliderMaxLayers
                  ? 'All layers on GPU.'
                  : effectiveGpuLayers === 0
                    ? 'CPU only — slowest, but no VRAM used.'
                    : `${sliderMaxLayers - effectiveGpuLayers} layers will run on CPU / RAM.`
              }
              value={effectiveGpuLayers}
              min={0}
              max={sliderMaxLayers}
              step={1}
              onChange={(v) => setCfg({ ...cfg, gpuLayers: v })}
              presets={[
                { label: 'CPU', value: 0 },
                { label: 'Half', value: Math.floor(sliderMaxLayers / 2) },
                { label: 'Max', value: sliderMaxLayers }
              ]}
            />
            <Slider
              label="CPU threads"
              hint="0 = auto-detect."
              value={cfg.threads ?? 0}
              min={0}
              max={64}
              step={1}
              onChange={(v) => setCfg({ ...cfg, threads: v })}
            />
            <Slider
              label="Eval batch size"
              hint="Tokens evaluated per pass. Larger = faster prompt processing, more VRAM."
              value={cfg.batchSize ?? 512}
              min={32}
              max={4096}
              step={32}
              onChange={(v) => setCfg({ ...cfg, batchSize: v })}
              presets={[
                { label: '128', value: 128 },
                { label: '512', value: 512 },
                { label: '1k', value: 1024 },
                { label: '2k', value: 2048 }
              ]}
            />
            </div>
          </CollapsibleSection>

          {hasMultiGpu && (
            <CollapsibleSection
              title={`Multiple GPUs (${gpuDevices.length})`}
              defaultOpen={false}
            >
            <div className="space-y-3">
              <ul className="space-y-1 text-[11px] text-zinc-400">
                {gpuDevices.map((g) => (
                  <li key={`${g.kind}-${g.index}`} className="rounded bg-zinc-900/60 px-2 py-1">
                    <span className="font-mono text-zinc-500">[{g.index}]</span>{' '}
                    <span className="uppercase text-indigo-300">{g.kind}</span> · {g.name} ·{' '}
                    {g.memory_mb ? `${(g.memory_mb / 1024).toFixed(1)} GB` : 'unknown VRAM'}
                  </li>
                ))}
              </ul>
              {isMixedVendor && (
                <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-2 text-[11px] text-amber-200">
                  Mixed-vendor setup ({[...vendorKinds].join(' + ')}). To split a model across them,
                  pick <strong>Vulkan</strong> below — CUDA/ROCm can&apos;t address each other&apos;s
                  cards. On Apple Silicon ignore this — Metal already covers everything.
                </p>
              )}
              <div>
                <Select
                  label="GPU backend"
                  value={cfg.gpuBackend ?? 'auto'}
                  options={[
                    { value: 'auto', label: 'Auto (best available)' },
                    {
                      value: 'cuda',
                      label: `CUDA — NVIDIA only${backendLabel(backends, 'cuda')}`
                    },
                    {
                      value: 'vulkan',
                      label: `Vulkan — works across vendors${backendLabel(backends, 'vulkan')}`
                    },
                    {
                      value: 'metal',
                      label: `Metal — Apple only${backendLabel(backends, 'metal')}`
                    },
                    {
                      value: 'cpu',
                      label: `CPU only${backendLabel(backends, 'cpu')}`
                    }
                  ]}
                  onChange={(v) => setCfg({ ...cfg, gpuBackend: v as ModelConfig['gpuBackend'] })}
                />
                {backends.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {backends.map((b) => (
                      <span
                        key={b.backend}
                        title={b.error}
                        className={`rounded px-2 py-0.5 text-[10px] uppercase ${
                          b.available
                            ? 'bg-emerald-700/30 text-emerald-200'
                            : 'bg-zinc-800 text-zinc-500'
                        }`}
                      >
                        {b.backend} {b.available ? '✓' : '✗'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <Select
                label="Main GPU (small tensors / KV cache)"
                value={String(cfg.mainGpu ?? 0)}
                options={gpuDevices.map((g) => ({
                  value: String(g.index),
                  label: `[${g.index}] ${g.kind.toUpperCase()} · ${g.name}`
                }))}
                onChange={(v) => setCfg({ ...cfg, mainGpu: Number(v) })}
              />
              <div>
                <p className="mb-1 text-xs text-zinc-300">Tensor split across GPUs</p>
                <p className="mb-2 text-[10px] text-zinc-500">
                  How much of the model each GPU holds. Defaults to VRAM-proportional. Set to all
                  zeros (or click <em>Single GPU</em>) to load everything on the Main GPU instead.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {gpuDevices.map((g, i) => {
                    const split = cfg.tensorSplit ?? []
                    const value = split[i] ?? 0
                    return (
                      <label key={`split-${g.index}`} className="text-[10px] text-zinc-400">
                        <span className="block truncate text-zinc-300">
                          [{g.index}] {g.kind.toUpperCase()} {g.name.slice(0, 20)}
                        </span>
                        <input
                          type="number"
                          min={0}
                          step={0.05}
                          value={value}
                          onChange={(e) => {
                            const next = [...(cfg.tensorSplit ?? [])]
                            while (next.length < gpuDevices.length) next.push(0)
                            next[i] = Number(e.target.value)
                            setCfg({ ...cfg, tensorSplit: next })
                          }}
                          className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs"
                        />
                      </label>
                    )
                  })}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const total = gpuDevices.reduce((a, g) => a + (g.memory_mb ?? 1), 0)
                      const split = gpuDevices.map((g) => Number(((g.memory_mb ?? 1) / total).toFixed(3)))
                      setCfg({ ...cfg, tensorSplit: split })
                    }}
                    className="rounded bg-zinc-800 px-2 py-0.5 text-[10px]"
                  >
                    Proportional to VRAM
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setCfg({
                        ...cfg,
                        tensorSplit: gpuDevices.map(() => Number((1 / gpuDevices.length).toFixed(3)))
                      })
                    }
                    className="rounded bg-zinc-800 px-2 py-0.5 text-[10px]"
                  >
                    Equal split
                  </button>
                  <button
                    type="button"
                    onClick={() => setCfg({ ...cfg, tensorSplit: [] })}
                    className="rounded bg-zinc-800 px-2 py-0.5 text-[10px]"
                  >
                    Single GPU (Main only)
                  </button>
                </div>
              </div>
            </div>
            </CollapsibleSection>
          )}

          <CollapsibleSection title="Context" defaultOpen={false}>
            <div className="space-y-4">
            <Slider
              label={`Context length (max ${ctxMax.toLocaleString()})`}
              hint="Longer context = more memory used for KV cache."
              value={cfg.contextSize}
              min={512}
              max={Math.max(cfg.contextSize, ctxMax)}
              step={512}
              onChange={(v) => setCfg({ ...cfg, contextSize: v })}
              presets={CTX_PRESETS.filter((p) => p.value <= ctxMax)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="K-cache type"
                value={cfg.kCacheType ?? 'f16'}
                options={CACHE_OPTS}
                onChange={(v) => setCfg({ ...cfg, kCacheType: v })}
                hint="Quantize key cache."
              />
              <Select
                label="V-cache type"
                value={cfg.vCacheType ?? 'f16'}
                options={CACHE_OPTS}
                onChange={(v) => setCfg({ ...cfg, vCacheType: v })}
                hint="Quantize value cache."
              />
            </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Options" defaultOpen={false}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="Chat attention backend"
              hint="Overrides Settings → Performance → Chat. Auto uses native llama.cpp kernels."
              value={modelAttentionSelectValue(cfg)}
              options={ATTENTION_OPTS}
              onChange={(v) => {
                const mode = v as GpuAttentionMode | ''
                if (!mode) {
                  const { attentionMode: _a, flashAttention: _f, ...rest } = cfg
                  setCfg(rest)
                  return
                }
                setCfg({
                  ...cfg,
                  attentionMode: mode,
                  flashAttention: undefined
                })
              }}
            />
            <Toggle
              label="Keep KV cache on GPU"
              hint="Faster inference, more VRAM."
              checked={cfg.kvCacheOnGpu ?? true}
              onChange={(v) => setCfg({ ...cfg, kvCacheOnGpu: v })}
            />
            <Toggle
              label="Memory-map model file (mmap)"
              hint="Faster load and lower RAM use."
              checked={cfg.useMmap ?? true}
              onChange={(v) => setCfg({ ...cfg, useMmap: v })}
            />
            <Toggle
              label="Lock model in RAM (mlock)"
              hint="Prevents swap; needs OS permission."
              checked={cfg.useMlock ?? false}
              onChange={(v) => setCfg({ ...cfg, useMlock: v })}
            />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Response speed" defaultOpen>
            <div className="space-y-3 text-xs">
              <p className="text-zinc-500">
                Thinking models can spend extra tokens on chain-of-thought before answering. Turn
                off for quicker replies on any model.
              </p>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={cfg.fastResponse ?? false}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      fastResponse: e.target.checked,
                      ...(e.target.checked ? { enableThinking: false } : {})
                    })
                  }
                />
                Fast response (shorter output, no thinking)
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={cfg.enableThinking ?? false}
                  disabled={cfg.fastResponse ?? false}
                  onChange={(e) => setCfg({ ...cfg, enableThinking: e.target.checked })}
                />
                Enable thinking / chain-of-thought
              </label>
              {(cfg.fastResponse ?? false) && (
                <p className="rounded border border-emerald-900/40 bg-emerald-950/30 p-2 text-emerald-200/90">
                  Fast mode: lower max tokens, no thinking tokens — best for quick chat and agent
                  tool rounds.
                </p>
              )}
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Advanced" defaultOpen={false}>
            <div className="space-y-4">
            <Slider
              label="Seed (-1 = random)"
              value={cfg.seed ?? -1}
              min={-1}
              max={2_147_483_647}
              step={1}
              onChange={(v) => setCfg({ ...cfg, seed: v })}
            />
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-300">System prompt override</p>
              <textarea
                value={cfg.systemPrompt ?? ''}
                onChange={(e) => setCfg({ ...cfg, systemPrompt: e.target.value })}
                rows={3}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
                placeholder="Leave blank to use the global system prompt"
              />
            </div>
            </div>
          </CollapsibleSection>

          {(supportsMtp || cfg.speculative?.enabled) && (
            <CollapsibleSection title="MTP / speculative decoding" defaultOpen={supportsMtp}>
              <div className="space-y-3 text-xs">
                {supportsMtp ? (
                  <p className="rounded-lg border border-violet-800/50 bg-violet-950/30 p-2 text-violet-200">
                    This model supports Multi-Token Prediction (MTP). On Windows, Omega uses{' '}
                    <strong>omega-engine</strong> (omega-infer subprocess) when MTP is enabled — not CPU-only
                    Ollama. Enable below, then load the model.
                  </p>
                ) : (
                  <p className="text-zinc-500">
                    Optional speculative decoding for this model (overrides global Settings when
                    enabled).
                  </p>
                )}
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={cfg.speculative?.enabled ?? false}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        speculative: {
                          ...(cfg.speculative ?? {}),
                          enabled: e.target.checked,
                          types: cfg.speculative?.types ?? ['draft-mtp']
                        }
                      })
                    }
                  />
                  Enable MTP / speculative decoding for this model
                </label>
                {(cfg.speculative?.enabled ?? false) && (
                  <>
                    <label className="flex items-center gap-2 text-zinc-400">
                      <input
                        type="checkbox"
                        checked={(cfg.speculative?.types ?? ['draft-mtp']).includes('draft-mtp')}
                        onChange={(e) => {
                          const types = new Set(cfg.speculative?.types ?? ['draft-mtp'])
                          if (e.target.checked) types.add('draft-mtp')
                          else types.delete('draft-mtp')
                          setCfg({
                            ...cfg,
                            speculative: {
                              ...cfg.speculative,
                              enabled: true,
                              types: [...types] as SpeculativeDecodingConfig['types']
                            }
                          })
                        }}
                      />
                      draft-mtp (recommended for MTP GGUF)
                    </label>
                    <label className="block text-zinc-400">
                      Draft GGUF path (optional — empty = same file)
                      <input
                        value={cfg.speculative?.draftModelPath ?? ''}
                        onChange={(e) =>
                          setCfg({
                            ...cfg,
                            speculative: {
                              ...cfg.speculative,
                              enabled: true,
                              draftModelPath: e.target.value
                            }
                          })
                        }
                        placeholder="C:\\Users\\…\\model-draft.gguf"
                        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px]"
                      />
                    </label>
                    <p className="text-[10px] text-zinc-500">
                      Bench sweet spot: nMax 2 (best tok/s on 12GB). Manual max {MTP_DRAFT_NMAX_ABSOLUTE}.
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="text-zinc-500">
                        nMax
                        <input
                          type="number"
                          min={1}
                          max={MTP_DRAFT_NMAX_ABSOLUTE}
                          value={cfg.speculative?.nMax ?? MTP_DRAFT_NMAX_DEFAULT}
                          onChange={(e) => {
                            const { nMax, nMin } = clampMtpDraftLimits(
                              Number(e.target.value),
                              cfg.speculative?.nMin
                            )
                            setCfg({
                              ...cfg,
                              speculative: {
                                ...cfg.speculative,
                                enabled: true,
                                nMax,
                                nMin
                              }
                            })
                          }}
                          className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
                        />
                      </label>
                      <label className="text-zinc-500">
                        nMin
                        <input
                          type="number"
                          min={0}
                          max={MTP_DRAFT_NMIN_ABSOLUTE}
                          value={cfg.speculative?.nMin ?? 0}
                          onChange={(e) => {
                            const { nMax, nMin } = clampMtpDraftLimits(
                              cfg.speculative?.nMax,
                              Number(e.target.value)
                            )
                            setCfg({
                              ...cfg,
                              speculative: {
                                ...cfg.speculative,
                                enabled: true,
                                nMax,
                                nMin
                              }
                            })
                          }}
                          className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
                        />
                      </label>
                      <label className="text-zinc-500">
                        pMin
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={cfg.speculative?.pMin ?? 0}
                          onChange={(e) =>
                            setCfg({
                              ...cfg,
                              speculative: {
                                ...cfg.speculative,
                                enabled: true,
                                pMin: Number(e.target.value)
                              }
                            })
                          }
                          className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            </CollapsibleSection>
          )}

          <CollapsibleSection title="LoRA adapters" defaultOpen={false}>
            <p className="mb-2 text-[11px] text-zinc-500">
              Search Hugging Face for GGUF LoRA files, download, and attach them to this model. Reload
              the model after saving for adapters to take effect.
            </p>
            <HfAdapterPanel
              forGguf
              adapters={cfg.adapters ?? []}
              onChange={(rows) =>
                setCfg({
                  ...cfg,
                  adapters: rows
                    .filter((r) => r.repoId && r.file)
                    .map((r) => ({
                      repoId: r.repoId,
                      file: r.file,
                      scale: r.scale ?? 1
                    }))
                })
              }
              downloadAdapter={async (repoId, file) => {
                await engineClient.models.downloadAdapter(repoId, file)
              }}
            />
          </CollapsibleSection>
        </div>

        <footer className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/70 px-6 py-3">
          {embedded ? (
            <p className="text-[11px] text-zinc-500">
              Changes apply on Save. Use Load on the model card to apply them to a running model.
            </p>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400"
            >
              Cancel
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                const fresh = await engineClient.modelConfig.reset(modelId)
                setCfg(fresh)
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </aside>
  )

  if (embedded) return aside

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      {aside}
    </div>
  )
}

function MemoryBar({
  estimate,
  gpuTotalMb
}: {
  estimate: MemoryEstimate
  gpuTotalMb?: number
}) {
  const max = Math.max(estimate.totalMb, gpuTotalMb ?? 0, 1)
  const gpuPct = (estimate.gpuMb / max) * 100
  const cpuPct = (estimate.cpuRamMb / max) * 100
  const overshoot = gpuTotalMb !== undefined && estimate.gpuMb > gpuTotalMb
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full ${
            overshoot ? 'bg-red-600' : 'bg-emerald-600'
          }`}
          style={{ width: `${gpuPct}%` }}
        />
        <div className="h-full bg-amber-500" style={{ width: `${cpuPct}%` }} />
      </div>
      <div className="flex flex-wrap gap-4 text-[11px] text-zinc-400">
        <span>
          <span className={`inline-block h-2 w-2 rounded-sm ${overshoot ? 'bg-red-500' : 'bg-emerald-500'}`} />{' '}
          GPU: {mb(estimate.gpuMb)}
          {gpuTotalMb ? ` / ${mb(gpuTotalMb)}` : ''}
        </span>
        <span>
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" /> CPU/RAM: {mb(estimate.cpuRamMb)}
        </span>
        <span className="text-zinc-500">KV cache: {mb(estimate.kvCacheMb)}</span>
        <span className="text-zinc-500">Per layer: {estimate.perLayerMb} MB</span>
      </div>
      {overshoot && (
        <p className="text-[11px] text-red-400">
          Estimated GPU use exceeds detected VRAM. Reduce GPU layers, quantize the KV cache, or shorten context.
        </p>
      )}
    </div>
  )
}
