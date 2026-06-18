import { useEffect, useState } from 'react'
import type { PluginInfo, ToolInfo } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [testName, setTestName] = useState('list_dir')
  const [testArgs, setTestArgs] = useState('{"path":"."}')
  const [testOut, setTestOut] = useState('')
  const [filter, setFilter] = useState('')

  const refresh = async () => {
    setTools(await engineClient.tools.list())
    setPlugins(await engineClient.plugins.list())
  }

  useEffect(() => {
    refresh()
  }, [])

  const toggle = async (name: string, enabled: boolean) => {
    await engineClient.tools.toggle(name, enabled)
    refresh()
  }

  const runTest = async () => {
    try {
      const args = JSON.parse(testArgs) as Record<string, string>
      const res = await engineClient.tools.run(testName, args)
      setTestOut(res.output)
    } catch (e) {
      setTestOut(e instanceof Error ? e.message : String(e))
    }
  }

  const reloadPlugins = async () => {
    await engineClient.plugins.reload()
    refresh()
  }

  const filtered = tools.filter(
    (t) => !filter || t.name.includes(filter.toLowerCase()) || t.description.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h2 className="text-lg font-semibold">Tool Runtime</h2>
        <p className="text-sm text-zinc-500">Built-in and plugin tools. Toggle, search, and test.</p>
      </header>
      <div className="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-2">
        <section>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tools…"
            className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <h3 className="mb-3 font-medium">Built-in tools ({filtered.filter((t) => t.source === 'builtin').length})</h3>
          <ul className="space-y-2">
            {filtered
              .filter((t) => t.source === 'builtin')
              .map((t) => (
                <li key={t.name} className="flex items-center justify-between rounded-lg border border-zinc-800 p-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-indigo-300">{t.name}</p>
                    <p className="text-xs text-zinc-500">{t.description}</p>
                    {t.needsApproval && (
                      <span className="mt-1 inline-block rounded bg-amber-900/40 px-2 py-0.5 text-[10px] uppercase text-amber-300">
                        approval required
                      </span>
                    )}
                  </div>
                  <input type="checkbox" checked={t.enabled} onChange={(e) => toggle(t.name, e.target.checked)} />
                </li>
              ))}
          </ul>
        </section>
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-medium">Plugins ({plugins.length})</h3>
            <button type="button" onClick={reloadPlugins} className="text-xs text-indigo-400 hover:underline">
              Reload from disk
            </button>
          </div>
          {plugins.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Drop plugins in <code>~/.omega/plugins/&lt;id&gt;/</code> with{' '}
              <code>omega-plugin.json</code> and <code>index.py</code>.
            </p>
          ) : (
            <ul className="space-y-2">
              {plugins.map((p) => (
                <li key={p.id} className="rounded-lg border border-zinc-800 p-3">
                  <div className="flex justify-between">
                    <span className="font-medium">{p.name}</span>
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => {
                        engineClient.plugins.toggle(p.id, e.target.checked).then(refresh)
                      }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500">
                    v{p.version} · {p.tools.join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mb-2 mt-6 font-medium">Test tool</h3>
          <input
            value={testName}
            onChange={(e) => setTestName(e.target.value)}
            className="mb-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm font-mono"
          />
          <textarea
            value={testArgs}
            onChange={(e) => setTestArgs(e.target.value)}
            rows={3}
            className="mb-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm font-mono"
          />
          <button type="button" onClick={runTest} className="rounded bg-indigo-600 px-3 py-1 text-sm">
            Run
          </button>
          {testOut && (
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-zinc-950 p-2 text-xs">{testOut}</pre>
          )}
        </section>
      </div>
    </div>
  )
}
