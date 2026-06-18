import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RemoteProvider } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function ProvidersPage() {
  const [providers, setProviders] = useState<RemoteProvider[]>([])
  const [presets, setPresets] = useState<RemoteProvider[]>([])
  const [editing, setEditing] = useState<RemoteProvider | null>(null)

  const reload = useCallback(async () => {
    const rows = await engineClient.providers.list()
    setProviders(rows)
    setEditing((prev) => (prev ? rows.find((p) => p.id === prev.id) ?? prev : null))
    return rows
  }, [])

  useEffect(() => {
    void reload()
    engineClient.providers.presets().then(setPresets)
  }, [reload])

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-80 shrink-0 flex-col border-r border-zinc-800">
        <div className="border-b border-zinc-800 p-4">
          <h2 className="text-lg font-semibold text-zinc-100">Cloud providers</h2>
          <p className="mt-1 text-xs text-zinc-500">
            OpenAI-compatible APIs (OpenRouter, Groq, etc.). Fetch models here, then pick one in Chat.
          </p>
        </div>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {providers.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setEditing(p)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  editing?.id === p.id
                    ? 'border-indigo-600 bg-indigo-950/40'
                    : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-200">{p.name}</p>
                    <p className="truncate text-[10px] text-zinc-500">{p.id}</p>
                    {p.defaultModel && (
                      <p className="mt-1 truncate font-mono text-[10px] text-cyan-300/90">
                        default: {p.defaultModel}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-zinc-600">
                      {(p.models ?? []).length
                        ? `${p.models!.length} model(s) in chat list`
                        : 'no models loaded yet'}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-0.5 text-[10px] ${
                      p.enabled ? 'bg-emerald-900/40 text-emerald-300' : 'bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    {p.enabled ? 'on' : 'off'}
                  </span>
                </div>
              </button>
            </li>
          ))}
          {providers.length === 0 && (
            <li className="px-2 py-6 text-center text-xs text-zinc-500">
              No providers yet. Add OpenRouter or another preset →
            </li>
          )}
        </ul>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!editing ? (
          <div className="mx-auto max-w-3xl space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Add a provider</h3>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {presets.map((preset) => {
                const already = providers.find((p) => p.id === preset.id)
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={!!already}
                    onClick={async () => {
                      const saved = await engineClient.providers.save({ ...preset, enabled: false })
                      await reload()
                      setEditing(saved)
                    }}
                    className={`rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left text-xs hover:border-indigo-600/50 ${
                      already ? 'cursor-not-allowed opacity-40' : ''
                    }`}
                  >
                    <p className="text-sm font-medium text-zinc-200">{preset.name}</p>
                    <p className="mt-0.5 truncate text-[10px] text-zinc-500">{preset.baseUrl}</p>
                    {already && <p className="mt-1 text-[10px] text-emerald-400">already added</p>}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <ProviderEditor
            value={editing}
            onReload={reload}
            onSave={async (v) => {
              const saved = await engineClient.providers.save(v)
              setEditing(saved)
              await reload()
            }}
            onDelete={async () => {
              if (confirm(`Delete provider ${editing.name}?`)) {
                await engineClient.providers.delete(editing.id)
                setEditing(null)
                await reload()
              }
            }}
            onUseInChat={async (qualifiedModelId) => {
              await engineClient.config.set({ defaultModel: qualifiedModelId })
            }}
          />
        )}
      </div>
    </div>
  )
}

function ProviderEditor({
  value,
  onSave,
  onDelete,
  onUseInChat,
  onReload
}: {
  value: RemoteProvider
  onSave: (v: RemoteProvider) => void | Promise<void>
  onDelete: () => void
  onUseInChat: (qualifiedModelId: string) => void | Promise<void>
  onReload: () => void | Promise<void>
}) {
  const [v, setV] = useState<RemoteProvider>(value)
  const [catalog, setCatalog] = useState<string[]>(value.models ?? [])
  const [fetchBusy, setFetchBusy] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(value.models ?? []))

  useEffect(() => {
    setV(value)
    setCatalog(value.models ?? [])
    setSelected(new Set(value.models ?? []))
    setFetchError(null)
  }, [value])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter((id) => id.toLowerCase().includes(q))
  }, [catalog, search])

  const loadFromApi = async (persist: boolean) => {
    setFetchBusy(true)
    setFetchError(null)
    try {
      const res = await engineClient.providers.fetchModels({
        id: v.id,
        persist,
        apiKey: v.apiKey,
        baseUrl: v.baseUrl,
        kind: v.kind
      })
      if (res.error) setFetchError(res.error)
      if (res.models.length) {
        setCatalog(res.models)
        setSelected(new Set(res.models))
        if (persist) {
          const next = {
            ...v,
            models: res.models,
            defaultModel:
              v.defaultModel && res.models.includes(v.defaultModel)
                ? v.defaultModel
                : res.models[0]
          }
          setV(next)
          await onReload()
        }
      } else if (!res.error) {
        setFetchError('No models returned — check API key and base URL.')
      }
    } finally {
      setFetchBusy(false)
    }
  }

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const applySelectionToProvider = (): RemoteProvider => {
    const models = catalog.filter((id) => selected.has(id))
    const defaultModel =
      v.defaultModel && models.includes(v.defaultModel) ? v.defaultModel : models[0]
    return { ...v, models, defaultModel }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
          className="min-w-[12rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-lg font-semibold"
        />
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={v.enabled}
            onChange={(e) => setV({ ...v, enabled: e.target.checked })}
          />
          Enabled (shows models in Chat)
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Row label="Kind">
          <select
            value={v.kind}
            onChange={(e) => setV({ ...v, kind: e.target.value as RemoteProvider['kind'] })}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="custom-openai">custom-openai (OpenRouter, Groq, …)</option>
            <option value="ollama">ollama (local)</option>
            <option value="lmstudio">lmstudio (local)</option>
          </select>
        </Row>
        <Row label="Base URL">
          <input
            value={v.baseUrl}
            onChange={(e) => setV({ ...v, baseUrl: e.target.value })}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm font-mono"
          />
        </Row>
      </div>

      <Row label="API key">
        <input
          type="password"
          value={v.apiKey ?? ''}
          onChange={(e) => setV({ ...v, apiKey: e.target.value })}
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
          placeholder="Required for OpenRouter / cloud APIs"
        />
      </Row>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-zinc-200">Models from API</h4>
            <p className="text-[11px] text-zinc-500">
              Load the provider&apos;s model list, choose which appear in Chat, and set a default.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={fetchBusy}
              onClick={() => void loadFromApi(false)}
              className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Preview
            </button>
            <button
              type="button"
              disabled={fetchBusy}
              onClick={() => void loadFromApi(true)}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            >
              {fetchBusy ? 'Loading…' : 'Load & save to provider'}
            </button>
          </div>
        </div>

        {fetchError && (
          <p className="mb-2 rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
            {fetchError}
          </p>
        )}

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models…"
          className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />

        <div className="mb-2 flex flex-wrap gap-2 text-[10px]">
          <button
            type="button"
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-300"
            onClick={() => setSelected(new Set(catalog))}
          >
            Select all ({catalog.length})
          </button>
          <button
            type="button"
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-300"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
          <span className="text-zinc-500">{selected.size} selected for Chat</span>
        </div>

        <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/80 p-2">
          {filtered.length === 0 && (
            <li className="py-6 text-center text-xs text-zinc-500">
              {catalog.length === 0
                ? 'Click “Load & save” after entering your API key.'
                : 'No models match search.'}
            </li>
          )}
          {filtered.map((modelId) => {
            const qualified = `${v.id}/${modelId}`
            const isDefault = v.defaultModel === modelId
            return (
              <li
                key={modelId}
                className={`flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-xs ${
                  isDefault ? 'bg-cyan-950/40 ring-1 ring-cyan-700/50' : 'hover:bg-zinc-900'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(modelId)}
                  onChange={() => toggleModel(modelId)}
                />
                <label className="min-w-0 flex-1 cursor-pointer font-mono text-zinc-300">
                  <input
                    type="radio"
                    name={`default-${v.id}`}
                    checked={isDefault}
                    onChange={() => setV({ ...v, defaultModel: modelId })}
                    className="mr-2"
                  />
                  {modelId}
                </label>
                <button
                  type="button"
                  className="rounded bg-emerald-800/50 px-2 py-0.5 text-[10px] text-emerald-200"
                  onClick={() => {
                    void (async () => {
                      const models = catalog.filter((id) => selected.has(id))
                      const list = models.includes(modelId) ? models : [...models, modelId]
                      const next = { ...v, enabled: true, models: list, defaultModel: modelId }
                      await onSave(next)
                      await onUseInChat(qualified)
                    })()
                  }}
                >
                  Use in Chat
                </button>
              </li>
            )
          })}
        </ul>

        <p className="mt-2 text-[10px] text-zinc-500">
          Chat model id: <span className="font-mono text-zinc-400">{v.id}/&lt;model&gt;</span> — e.g.{' '}
          <span className="font-mono text-cyan-300/80">
            {v.id}/{v.defaultModel ?? 'model-name'}
          </span>
        </p>
      </section>

      <Row label="Manual model list (comma-separated; overrides after save)">
        <input
          value={(v.models ?? []).join(', ')}
          onChange={(e) => {
            const models = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            setV({ ...v, models })
            setCatalog(models)
            setSelected(new Set(models))
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm font-mono"
          placeholder="anthropic/claude-3.5-sonnet, openai/gpt-4o-mini"
        />
      </Row>

      <div className="flex justify-between border-t border-zinc-800 pt-4">
        <button type="button" onClick={onDelete} className="text-xs text-red-400 hover:text-red-300">
          Delete provider
        </button>
        <button
          type="button"
          onClick={() => onSave(applySelectionToProvider())}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium"
        >
          Save provider
        </button>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs text-zinc-400">{label}</p>
      {children}
    </div>
  )
}
