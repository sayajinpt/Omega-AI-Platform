import { useEffect, useMemo, useState } from 'react'
import { AgentErrorBanner } from '../components/AgentErrorBanner'
import { formatAgentError } from '../lib/agent-errors'
import type { Page } from '../App'
import type {
  GatewayPlatformConfig,
  GatewayPlatformId,
  GatewayStatus,
  ModelInfo
} from '@omega/sdk'
import { engineClient } from '../lib/engine'

interface PlatformMeta {
  id: GatewayPlatformId
  label: string
  group: string
  implemented: boolean
  fields: Array<{ name: string; label: string; type?: 'text' | 'password' | 'url' }>
}

export function GatewayPage({
  models,
  onNavigate
}: {
  models: ModelInfo[]
  onNavigate?: (page: Page) => void
}) {
  const [platforms, setPlatforms] = useState<PlatformMeta[]>([])
  const [configs, setConfigs] = useState<GatewayPlatformConfig[]>([])
  const [statuses, setStatuses] = useState<GatewayStatus[]>([])
  const [editing, setEditing] = useState<PlatformMeta | null>(null)

  const reload = async () => {
    setConfigs(await engineClient.gateway.list())
    setStatuses(await engineClient.gateway.status())
  }

  useEffect(() => {
    engineClient.gateway.platforms().then(setPlatforms)
    reload()
    return engineClient.gateway.onStatus(setStatuses)
  }, [])

  const grouped = useMemo(() => {
    const g: Record<string, PlatformMeta[]> = {}
    for (const p of platforms) (g[p.group] ??= []).push(p)
    return g
  }, [platforms])

  const cfgOf = (id: GatewayPlatformId): GatewayPlatformConfig | undefined => configs.find((c) => c.id === id)
  const statusOf = (id: GatewayPlatformId): GatewayStatus | undefined => statuses.find((s) => s.id === id)

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Messaging gateway</h2>
          <p className="text-xs text-zinc-500">
            Bridge Omega to chat platforms. Inbound endpoints land at{' '}
            <span className="font-mono">/v1/gateway/&lt;platform&gt;</span>.
          </p>
        </div>
        {Object.entries(grouped).map(([group, items]) => (
          <section key={group} className="mb-6">
            <h3 className="mb-2 text-xs uppercase text-zinc-500">{group}</h3>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {items.map((p) => {
                const cfg = cfgOf(p.id)
                const st = statusOf(p.id)
                const enabled = cfg?.enabled
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setEditing(p)}
                    className={`rounded-lg border p-3 text-left transition ${
                      enabled
                        ? 'border-indigo-700/60 bg-indigo-950/30'
                        : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <p className="text-sm font-medium">{p.label}</p>
                      {!p.implemented && (
                        <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[9px] text-amber-300">
                          stub
                        </span>
                      )}
                      {p.implemented && st?.running && (
                        <span className="rounded bg-emerald-700/40 px-1.5 py-0.5 text-[9px] text-emerald-300">
                          on
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-zinc-500">
                      {cfg ? 'configured' : 'not configured'}
                    </p>
                    {st && (
                      <p className="mt-1 text-[10px] text-zinc-500">
                        in: {st.messagesIn} · out: {st.messagesOut}
                      </p>
                    )}
                    {st?.lastError && (
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        <AgentErrorBanner
                          hint={formatAgentError(st.lastError, 'gateway')}
                          onNavigate={onNavigate}
                        />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {editing && (
        <PlatformEditor
          platform={editing}
          config={cfgOf(editing.id)}
          models={models}
          onClose={() => setEditing(null)}
          onSave={async (cfg) => {
            await engineClient.gateway.save(cfg)
            reload()
          }}
          onDelete={async () => {
            await engineClient.gateway.delete(editing.id)
            setEditing(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

function PlatformEditor({
  platform,
  config,
  models,
  onClose,
  onSave,
  onDelete
}: {
  platform: PlatformMeta
  config?: GatewayPlatformConfig
  models: ModelInfo[]
  onClose: () => void
  onSave: (c: GatewayPlatformConfig) => void
  onDelete: () => void
}) {
  const [c, setC] = useState<GatewayPlatformConfig>(
    config ?? {
      id: platform.id,
      enabled: false,
      fields: {},
      agentMode: false,
      modelId: undefined,
      trigger: '',
      allowList: []
    }
  )

  return (
    <div onClick={onClose} className="fixed inset-0 z-30 flex justify-end bg-black/60 backdrop-blur-sm">
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-6"
      >
        <header>
          <p className="text-xs uppercase text-zinc-500">Platform</p>
          <h2 className="text-lg font-semibold">{platform.label}</h2>
          {!platform.implemented && (
            <p className="mt-1 rounded bg-amber-900/30 px-2 py-1 text-[10px] text-amber-300">
              Transport not yet implemented — configuration is stored, but no messages will flow.
            </p>
          )}
        </header>
        {platform.fields.map((f) => (
          <div key={f.name}>
            <p className="mb-1 text-xs text-zinc-400">{f.label}</p>
            <input
              type={f.type === 'password' ? 'password' : 'text'}
              value={c.fields[f.name] ?? ''}
              onChange={(e) => setC({ ...c, fields: { ...c.fields, [f.name]: e.target.value } })}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
            />
          </div>
        ))}
        <div>
          <p className="mb-1 text-xs text-zinc-400">Reply with model</p>
          <select
            value={c.modelId ?? ''}
            onChange={(e) => setC({ ...c, modelId: e.target.value || undefined })}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
          >
            <option value="">(use default)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-400">Trigger regex (optional)</p>
          <input
            value={c.trigger ?? ''}
            onChange={(e) => setC({ ...c, trigger: e.target.value })}
            placeholder="e.g. ^@omega"
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs"
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-400">Allow list (one per line — usernames or IDs)</p>
          <textarea
            value={(c.allowList ?? []).join('\n')}
            onChange={(e) =>
              setC({ ...c, allowList: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })
            }
            rows={3}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={c.agentMode ?? false}
            onChange={(e) => setC({ ...c, agentMode: e.target.checked })}
          />
          Use full agent (tools + memory)
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={c.enabled}
            onChange={(e) => setC({ ...c, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <div className="flex justify-between border-t border-zinc-800 pt-3">
          {config ? (
            <button type="button" onClick={onDelete} className="text-xs text-red-400">
              Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="text-xs text-zinc-400">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(c)}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm"
            >
              Save
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}
