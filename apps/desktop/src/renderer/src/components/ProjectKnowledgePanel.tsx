import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntry, ProjectMemoryContext } from '@omega/sdk'
import { CollapsibleSection } from './CollapsibleSection'
import { engineClient } from '../lib/engine'

export function ProjectKnowledgePanel({
  sessionId,
  compact = false,
  compactExpandedMaxHeight = 360
}: {
  sessionId: string | null
  compact?: boolean
  compactExpandedMaxHeight?: number
}) {
  const [ctx, setCtx] = useState<ProjectMemoryContext | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setCtx(await engineClient.memory.projectContext(sessionId ?? undefined))
    } catch (e) {
      setCtx(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  useEffect(() => {
    void reload()
  }, [reload])

  const sectionProps = compact
    ? { compact: true as const, defaultOpen: false, compactExpandedMaxHeight }
    : {}

  if (!ctx && !error) {
    return (
      <CollapsibleSection title="What Omega knows" {...sectionProps}>
        <p className="text-[10px] text-zinc-500">{busy ? 'Loading project context…' : 'No context yet.'}</p>
      </CollapsibleSection>
    )
  }

  if (error && !ctx) {
    return (
      <CollapsibleSection title="What Omega knows" {...sectionProps}>
        <p className="text-xs text-rose-300/90">{error}</p>
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-2 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
        >
          Retry
        </button>
      </CollapsibleSection>
    )
  }

  if (!ctx) return null

  const rows = [...ctx.workspaceEntries, ...ctx.sessionEntries]
  const unique = new Map<string, MemoryEntry>()
  for (const e of rows) unique.set(e.id, e)
  const entries = [...unique.values()].slice(0, compact ? 6 : 16)

  return (
    <CollapsibleSection title="What Omega knows" {...sectionProps}>
      <div className="space-y-1.5 text-[10px]">
        <p className="text-zinc-500">
          Project folder: <span className="font-mono text-zinc-400">{ctx.projectDir ?? ctx.workspace}</span>
          {typeof ctx.projectFileCount === 'number' && (
            <span className="ml-2 text-zinc-600">· {ctx.projectFileCount} file(s)</span>
          )}
          {sessionId && (
            <span className="ml-2 text-zinc-600">
              · memory: {ctx.sessionEntries.length}
            </span>
          )}
        </p>
        {sessionId && (
          <button
            type="button"
            onClick={() => void engineClient.project.openFolder(sessionId)}
            className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-zinc-800"
          >
            Open project folder
          </button>
        )}
        {busy && <p className="text-zinc-600">Refreshing…</p>}
        {entries.length === 0 ? (
          <p className="text-zinc-600">
            No facts yet. Use /save, agent memory tools, or self-improve after chats.
          </p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {entries.map((e) => (
              <li key={e.id} className="rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1">
                <span className="text-[9px] uppercase text-zinc-600">{e.kind}</span>
                {e.sessionId && (
                  <span className="ml-1 text-[9px] text-indigo-500/80">session</span>
                )}
                <p className="line-clamp-2 text-zinc-300">{e.content}</p>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>
    </CollapsibleSection>
  )
}
