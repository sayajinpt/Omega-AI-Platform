import { useEffect, useState } from 'react'
import type { McpServerConfig, McpServerStatus, McpTransport } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function McpPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [editing, setEditing] = useState<McpServerConfig | null>(null)

  const reload = async () => {
    setServers(await engineClient.mcp.list())
    setStatus(await engineClient.mcp.status())
  }
  useEffect(() => {
    reload()
    return engineClient.mcp.onStatus(setStatus)
  }, [])

  const statusOf = (id: string) => status.find((s) => s.id === id)

  return (
    <div className="flex h-full">
      <div className="w-1/2 overflow-y-auto border-r border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">MCP servers</h2>
            <p className="text-xs text-zinc-500">
              Connect external Model Context Protocol servers. Their tools appear in the agent toolbox.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setEditing({
                id: `mcp-${Date.now()}`,
                name: 'New server',
                enabled: false,
                transport: { kind: 'stdio', command: '', args: [] }
              })
            }
            className="rounded bg-indigo-600 px-3 py-1 text-xs"
          >
            New
          </button>
        </div>
        <ul className="space-y-2">
          {servers.map((s) => {
            const st = statusOf(s.id)
            return (
              <li
                key={s.id}
                onClick={() => setEditing(s)}
                className={`cursor-pointer rounded-lg border p-3 ${editing?.id === s.id ? 'border-indigo-600 bg-indigo-950/30' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="text-[10px] text-zinc-500">
                      {s.transport.kind === 'stdio'
                        ? `stdio · ${s.transport.command}`
                        : `http · ${s.transport.url}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-0.5 text-[10px] ${
                      st?.state === 'ready'
                        ? 'bg-emerald-700/30 text-emerald-300'
                        : st?.state === 'error'
                          ? 'bg-red-900/40 text-red-300'
                          : 'bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    {st?.state ?? 'stopped'}
                  </span>
                </div>
                {st?.error && <p className="mt-1 text-[10px] text-red-400">{st.error}</p>}
                {st && (
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {st.toolCount} tools · {st.resourceCount} resources
                  </p>
                )}
                <div className="mt-2 flex gap-2 text-[10px]" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => engineClient.mcp.start(s.id)}
                    className="rounded bg-zinc-800 px-2 py-0.5"
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={() => engineClient.mcp.stop(s.id)}
                    className="rounded bg-zinc-800 px-2 py-0.5"
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (confirm(`Delete ${s.name}?`)) {
                        await engineClient.mcp.delete(s.id)
                        reload()
                        if (editing?.id === s.id) setEditing(null)
                      }
                    }}
                    className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
          {servers.length === 0 && <p className="text-sm text-zinc-500">No MCP servers configured.</p>}
        </ul>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!editing ? (
          <p className="text-sm text-zinc-500">Select a server or create one.</p>
        ) : (
          <McpEditor
            value={editing}
            onSave={async (v) => {
              const saved = await engineClient.mcp.save(v)
              setEditing(saved)
              reload()
            }}
          />
        )}
      </div>
    </div>
  )
}

function McpEditor({ value, onSave }: { value: McpServerConfig; onSave: (v: McpServerConfig) => void }) {
  const [v, setV] = useState<McpServerConfig>(value)
  useEffect(() => setV(value), [value])

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <input
        value={v.name}
        onChange={(e) => setV({ ...v, name: e.target.value })}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-lg font-semibold"
      />
      <textarea
        value={v.description ?? ''}
        onChange={(e) => setV({ ...v, description: e.target.value })}
        rows={2}
        placeholder="Description"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
      />
      <div>
        <p className="mb-1 text-xs text-zinc-400">Transport</p>
        <div className="flex gap-2">
          {(['stdio', 'http'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() =>
                setV({
                  ...v,
                  transport:
                    k === 'stdio'
                      ? { kind: 'stdio', command: '', args: [] }
                      : { kind: 'http', url: '' }
                })
              }
              className={`rounded px-3 py-1 text-xs ${v.transport.kind === k ? 'bg-indigo-700 text-white' : 'bg-zinc-800 text-zinc-400'}`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      {v.transport.kind === 'stdio' ? (
        <StdioFields
          t={v.transport}
          onChange={(t: McpTransport) => setV({ ...v, transport: t })}
        />
      ) : (
        <HttpFields t={v.transport} onChange={(t: McpTransport) => setV({ ...v, transport: t })} />
      )}
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.target.checked })}
        />
        Auto-start on launch
      </label>
      <button type="button" onClick={() => onSave(v)} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm">
        Save
      </button>
    </div>
  )
}

function StdioFields({ t, onChange }: { t: Extract<McpTransport, { kind: 'stdio' }>; onChange: (t: McpTransport) => void }) {
  return (
    <div className="space-y-3">
      <Input label="Command" value={t.command} onChange={(command) => onChange({ ...t, command })} placeholder="e.g. npx" />
      <Input
        label="Arguments (one per line)"
        value={(t.args ?? []).join('\n')}
        onChange={(s) => onChange({ ...t, args: s.split('\n').map((x) => x.trim()).filter(Boolean) })}
        multiline
      />
      <Input
        label="Env (KEY=value per line)"
        value={Object.entries(t.env ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')}
        onChange={(s) => {
          const env: Record<string, string> = {}
          for (const line of s.split('\n')) {
            const eq = line.indexOf('=')
            if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
          }
          onChange({ ...t, env })
        }}
        multiline
      />
      <Input label="Working dir (optional)" value={t.cwd ?? ''} onChange={(cwd) => onChange({ ...t, cwd })} />
    </div>
  )
}

function HttpFields({ t, onChange }: { t: Extract<McpTransport, { kind: 'http' }>; onChange: (t: McpTransport) => void }) {
  return (
    <div className="space-y-3">
      <Input label="URL" value={t.url} onChange={(url) => onChange({ ...t, url })} placeholder="https://…" />
      <Input
        label="Headers (KEY: value per line)"
        value={Object.entries(t.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')}
        onChange={(s) => {
          const headers: Record<string, string> = {}
          for (const line of s.split('\n')) {
            const c = line.indexOf(':')
            if (c > 0) headers[line.slice(0, c).trim()] = line.slice(c + 1).trim()
          }
          onChange({ ...t, headers })
        }}
        multiline
      />
    </div>
  )
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  multiline
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
}) {
  return (
    <div>
      <p className="mb-1 text-xs text-zinc-400">{label}</p>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={placeholder}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
        />
      )}
    </div>
  )
}
