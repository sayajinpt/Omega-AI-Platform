import { useState } from 'react'
import type { OfficeMonitor } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function OfficeJiraPanel({
  monitor,
  onRefresh
}: {
  monitor: OfficeMonitor
  onRefresh?: () => void
}) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const jira = monitor.jira

  const postComment = async () => {
    if (!comment.trim() || !jira) return
    setBusy(true)
    setErr(null)
    try {
      await engineClient.office.jiraComment(jira.key, comment.trim())
      setComment('')
      onRefresh?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!jira) {
    return (
      <div className="rounded border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200/90">
        <p>No issue loaded. Configure Jira in Settings → Integrations, then refresh.</p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 rounded border border-amber-700 px-2 py-0.5 text-[10px]"
          >
            Fetch issue
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="border-b border-zinc-800 pb-2">
        <p className="font-medium text-zinc-200">
          {jira.key} · {jira.issueType ?? 'Issue'}
        </p>
        <p className="mt-0.5 text-[10px] text-zinc-400">{jira.summary}</p>
        <p className="mt-1 text-[9px] text-zinc-500">
          {jira.status}
          {jira.priority ? ` · ${jira.priority}` : ''}
          {jira.assignee ? ` · ${jira.assignee}` : ''}
        </p>
        {jira.url && (
          <a
            href={jira.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-[9px] text-indigo-400 hover:underline"
          >
            Open in Jira
          </a>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          >
            Refresh issue
          </button>
        )}
      </div>
      {jira.description && (
        <div className="mt-2 max-h-24 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/60 p-2 text-[10px] text-zinc-400">
          {jira.description}
        </div>
      )}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1 text-[9px] uppercase text-zinc-600">Comments</p>
        {jira.comments.length === 0 && (
          <p className="text-[10px] text-zinc-600">No comments yet.</p>
        )}
        <ul className="space-y-2">
          {jira.comments.map((c, i) => (
            <li key={i} className="rounded border border-zinc-800 bg-zinc-950/50 p-1.5">
              <p className="text-[9px] text-zinc-500">{c.author}</p>
              <p className="mt-0.5 text-[10px] text-zinc-300">{c.body}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-2 border-t border-zinc-800 pt-2">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Add Jira comment…"
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px]"
        />
        <button
          type="button"
          disabled={busy || !comment.trim()}
          onClick={() => void postComment()}
          className="mt-1 rounded bg-indigo-600 px-2 py-0.5 text-[10px] text-white disabled:opacity-40"
        >
          {busy ? 'Posting…' : 'Post comment'}
        </button>
        {err && <p className="mt-1 text-[9px] text-red-400">{err}</p>}
      </div>
    </div>
  )
}
