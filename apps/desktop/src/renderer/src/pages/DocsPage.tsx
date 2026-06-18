import { useCallback, useEffect, useState } from 'react'
import type { RagHit, RagSource } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function DocsPage() {
  const [sources, setSources] = useState<RagSource[]>([])
  const [busy, setBusy] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<RagHit[]>([])

  const refresh = useCallback(async () => {
    setSources(await engineClient.rag.list())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const indexFile = async () => {
    if (!filePath) return
    setBusy(true)
    try {
      const n = await engineClient.rag.indexFile(filePath)
      setLog((l) => [`Indexed ${n} chunks from ${filePath}`, ...l])
      refresh()
    } catch (e) {
      setLog((l) => [String(e instanceof Error ? e.message : e), ...l])
    } finally {
      setBusy(false)
    }
  }

  const indexDir = async () => {
    if (!dirPath) return
    setBusy(true)
    try {
      const r = await engineClient.rag.indexDir(dirPath)
      setLog((l) => [`Indexed ${r.files} files (${r.chunks} chunks) from ${dirPath}`, ...l])
      refresh()
    } catch (e) {
      setLog((l) => [String(e instanceof Error ? e.message : e), ...l])
    } finally {
      setBusy(false)
    }
  }

  const search = async () => {
    setHits(await engineClient.rag.search(query))
  }

  const clear = async (source?: string) => {
    if (!confirm(source ? `Remove ${source}?` : 'Clear entire RAG index?')) return
    await engineClient.rag.clear(source)
    refresh()
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-1/2 flex-col overflow-y-auto border-r border-zinc-800 p-6">
        <h2 className="mb-1 text-lg font-semibold">Documents (RAG)</h2>
        <p className="mb-6 text-sm text-zinc-500">
          Index local files for semantic retrieval. Available as the <code>search_docs</code> tool.
        </p>

        <section className="mb-6 space-y-3">
          <h3 className="text-sm font-medium">Index file</h3>
          <input
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="Absolute path to a text/code file"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button type="button" disabled={busy} onClick={indexFile} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm">
            Index file
          </button>
        </section>

        <section className="mb-6 space-y-3">
          <h3 className="text-sm font-medium">Index directory (recursive)</h3>
          <input
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            placeholder="Absolute path to a directory"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button type="button" disabled={busy} onClick={indexDir} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm">
            Index directory
          </button>
        </section>

        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Indexed sources</h3>
            <button type="button" onClick={() => clear()} className="text-xs text-red-400">
              Clear all
            </button>
          </div>
          {sources.length === 0 ? (
            <p className="text-sm text-zinc-500">No sources indexed yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {sources.map((s) => (
                <li key={s.source} className="flex items-center justify-between rounded border border-zinc-800 p-2">
                  <span className="truncate font-mono text-xs text-zinc-300">{s.source}</span>
                  <span className="ml-2 text-xs text-zinc-500">{s.chunks} chunks</span>
                  <button onClick={() => clear(s.source)} type="button" className="ml-2 text-xs text-red-400">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {log.length > 0 && (
          <pre className="max-h-32 overflow-y-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">
            {log.join('\n')}
          </pre>
        )}
      </div>

      <div className="flex w-1/2 flex-col overflow-y-auto p-6">
        <h3 className="mb-3 text-sm font-medium">Search documents</h3>
        <div className="mb-3 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Semantic search…"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button type="button" onClick={search} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm">
            Search
          </button>
        </div>
        <ul className="space-y-3">
          {hits.map((h, i) => (
            <li key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
                <span className="truncate font-mono">{h.source}#{h.chunkIdx}</span>
                <span>score {h.score.toFixed(3)}</span>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-zinc-300">{h.content.slice(0, 1200)}</pre>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
