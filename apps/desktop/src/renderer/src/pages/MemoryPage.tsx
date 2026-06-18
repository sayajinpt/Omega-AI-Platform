import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { DecisionNode, MemoryEntry } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function MemoryPage({ entries, onRefresh }: { entries: MemoryEntry[]; onRefresh: () => void }) {
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<MemoryEntry['kind']>('fact')
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<MemoryEntry[]>([])
  const [graph, setGraph] = useState<DecisionNode[]>([])
  const [tab, setTab] = useState<'entries' | 'graph'>('entries')
  const [bundleMsg, setBundleMsg] = useState<string | null>(null)

  useEffect(() => {
    engineClient.memory
      .graph()
      .then((g) => setGraph(Array.isArray(g) ? g : []))
      .catch(() => setGraph([]))
  }, [entries])

  const add = async () => {
    if (!content.trim()) return
    await engineClient.memory.add(kind, content.trim())
    setContent('')
    onRefresh()
  }

  const remove = async (id: string) => {
    await engineClient.memory.delete(id)
    onRefresh()
  }

  const search = async () => {
    if (!searchQ.trim()) return
    setSearchHits(await engineClient.memory.search(searchQ))
  }

  const exportBundle = async () => {
    const bundle = await engineClient.memory.exportBundle()
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `omega-memory-${bundle.profileId}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setBundleMsg(`Exported ${bundle.entries.length} entries`)
  }

  const importBundle = async (replace: boolean) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const bundle = JSON.parse(text) as import('@omega/sdk').MemoryBundle
        const r = await engineClient.memory.importBundle(bundle, replace ? 'replace' : 'merge')
        setBundleMsg(
          `${replace ? 'Replaced' : 'Merged'}: ${r.imported} imported, ${r.skipped} skipped`
        )
        onRefresh()
      } catch (e) {
        setBundleMsg(e instanceof Error ? e.message : String(e))
      }
    }
    input.click()
  }

  const runJanitor = async () => {
    const r = await engineClient.memory.runJanitor()
    setBundleMsg(r.note)
    onRefresh()
  }

  const grouped = useMemo(() => {
    const byRun = new Map<string, DecisionNode[]>()
    for (const d of graph) {
      const k = d.runId
      if (!byRun.has(k)) byRun.set(k, [])
      byRun.get(k)!.push(d)
    }
    return [...byRun.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map((n) => n.createdAt))
      const bMax = Math.max(...b[1].map((n) => n.createdAt))
      return bMax - aMax
    })
  }, [graph])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">Unified Memory</h2>
          <p className="text-sm text-zinc-500">FTS + vector index + decision graph</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void exportBundle()}
            className="rounded border border-zinc-600 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Export bundle
          </button>
          <button
            type="button"
            onClick={() => void importBundle(false)}
            className="rounded border border-zinc-600 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Import merge
          </button>
          <button
            type="button"
            onClick={() => void importBundle(true)}
            className="rounded border border-rose-800 px-3 py-1 text-xs text-rose-300 hover:bg-rose-950/40"
          >
            Import replace
          </button>
          <button
            type="button"
            onClick={() => void runJanitor()}
            className="rounded border border-zinc-600 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Run memory janitor
          </button>
          {bundleMsg && <span className="text-[10px] text-zinc-500">{bundleMsg}</span>}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('entries')}
            className={`rounded px-3 py-1 text-sm ${tab === 'entries' ? 'bg-indigo-600' : 'bg-zinc-800'}`}
          >
            Entries ({entries.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('graph')}
            className={`rounded px-3 py-1 text-sm ${tab === 'graph' ? 'bg-indigo-600' : 'bg-zinc-800'}`}
          >
            Decision graph ({grouped.length} runs)
          </button>
        </div>
      </header>

      {tab === 'entries' ? (
        <>
          <div className="border-b border-zinc-800 p-6">
            <div className="mb-3 flex gap-2">
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search memory (FTS5)…"
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
              <button type="button" onClick={search} className="rounded-lg border border-zinc-600 px-4 py-2 text-sm">
                Search
              </button>
              {searchHits.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchHits([])
                    setSearchQ('')
                  }}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as MemoryEntry['kind'])}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
              >
                <option value="fact">fact</option>
                <option value="preference">preference</option>
                <option value="task">task</option>
                <option value="decision">decision</option>
              </select>
              <input
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Add memory…"
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
              <button type="button" onClick={add} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm">
                Add
              </button>
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto p-6">
            {(searchHits.length ? searchHits : entries).map((e) => (
              <li key={e.id} className="mb-3 flex justify-between rounded-lg border border-zinc-800 p-4">
                <div className="min-w-0">
                  <span className="text-xs uppercase text-indigo-400">{e.kind}</span>
                  {e.sessionId && (
                    <span className="ml-2 text-[9px] text-indigo-500/80">session-linked</span>
                  )}
                  <p className="mt-1 text-sm">{e.content}</p>
                  <p className="mt-1 text-[10px] text-zinc-600">
                    {new Date(e.createdAt).toLocaleString()}
                  </p>
                </div>
                <button type="button" onClick={() => remove(e.id)} className="text-xs text-red-400">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {grouped.length === 0 ? (
            <p className="text-sm text-zinc-500">Agent decisions appear here after runs.</p>
          ) : (
            grouped.map(([runId, nodes]) => (
              <div key={runId} className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <p className="mb-3 font-mono text-xs text-zinc-500">run {runId}</p>
                <RunDag nodes={nodes} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function RunDag({ nodes }: { nodes: DecisionNode[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childrenMap = new Map<string, DecisionNode[]>()
  for (const n of nodes) {
    const key = n.parentId ?? '__root__'
    if (!childrenMap.has(key)) childrenMap.set(key, [])
    childrenMap.get(key)!.push(n)
  }

  function render(parentKey: string, depth = 0): ReactElement[] {
    return (childrenMap.get(parentKey) ?? []).map((n) => (
      <div key={n.id} style={{ marginLeft: depth * 18 }} className="my-1">
        <div className="flex items-start gap-2">
          <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-indigo-500" />
          <div className="min-w-0">
            <span className="text-xs font-medium text-indigo-300">{n.label}</span>
            {n.detail && (
              <pre className="ml-1 whitespace-pre-wrap text-xs text-zinc-400">{n.detail.slice(0, 400)}</pre>
            )}
          </div>
        </div>
        {render(n.id, depth + 1)}
      </div>
    ))
  }

  const renderResult = render('__root__')
  const orphans: ReactElement[] = []
  for (const n of nodes) {
    if (!n.parentId) continue
    if (!byId.has(n.parentId)) {
      orphans.push(
        <div key={n.id} className="my-1">
          <span className="text-xs text-indigo-300">{n.label}</span>
          {n.detail && (
            <pre className="ml-3 whitespace-pre-wrap text-xs text-zinc-400">{n.detail.slice(0, 400)}</pre>
          )}
        </div>
      )
    }
  }
  return (
    <div>
      {renderResult}
      {orphans}
    </div>
  )
}
