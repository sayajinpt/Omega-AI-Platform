import { useEffect, useState } from 'react'
import type { PluginCatalogEntry } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function PluginStorePage() {
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const reload = async () => setCatalog(await engineClient.pluginStore.catalog())
  useEffect(() => {
    reload()
  }, [])

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold">Plugin marketplace</h2>
        <p className="text-xs text-zinc-500">
          Install plugins from the built-in catalog, or paste a URL to a <span className="font-mono">.js</span>,{' '}
          <span className="font-mono">.zip</span>, or git repo. Plugins live in{' '}
          <span className="font-mono">~/.omega/plugins/&lt;id&gt;</span>.
        </p>
      </header>

      <section>
        <h3 className="mb-2 text-xs uppercase text-zinc-500">Install from URL</h3>
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/my-plugin.zip"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={!url || busy}
            onClick={async () => {
              setBusy(true)
              setMsg('')
              try {
                const m = await engineClient.pluginStore.installUrl(url)
                setMsg(`Installed ${m.name} (${m.version})`)
                setUrl('')
                await reload()
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e))
              } finally {
                setBusy(false)
              }
            }}
            className="rounded-lg bg-indigo-600 px-4 text-sm disabled:opacity-40"
          >
            {busy ? '…' : 'Install'}
          </button>
        </div>
        {msg && <p className="mt-2 text-xs text-zinc-400">{msg}</p>}
      </section>

      <section>
        <h3 className="mb-2 text-xs uppercase text-zinc-500">Catalog</h3>
        <ul className="space-y-2">
          {catalog.map((p) => (
            <li key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {p.name}{' '}
                    <span className="text-[10px] text-zinc-600">v{p.version}</span>
                  </p>
                  <p className="text-xs text-zinc-500">{p.description}</p>
                  {p.tools && (
                    <p className="mt-1 text-[10px] text-zinc-600">tools: {p.tools.join(', ')}</p>
                  )}
                  {p.permissions && p.permissions.length > 0 && (
                    <p className="mt-1 text-[10px] text-amber-400">
                      permissions: {p.permissions.join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {p.installed ? (
                    <button
                      type="button"
                      onClick={async () => {
                        if (confirm(`Uninstall ${p.name}?`)) {
                          await engineClient.pluginStore.uninstall(p.id)
                          reload()
                        }
                      }}
                      className="rounded bg-zinc-800 px-3 py-1 text-xs text-red-300"
                    >
                      Uninstall
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={async () => {
                        await engineClient.pluginStore.installBuiltin(p.id)
                        reload()
                      }}
                      className="rounded bg-indigo-600 px-3 py-1 text-xs"
                    >
                      Install
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
