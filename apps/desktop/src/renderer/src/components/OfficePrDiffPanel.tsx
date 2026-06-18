import { useMemo, useState } from 'react'
import type { OfficeMonitor, PrDiffFile } from '@omega/sdk'
import { engineClient } from '../lib/engine'

function DiffLine({ line }: { line: string }) {
  let cls = 'text-zinc-400'
  if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400/90 bg-emerald-950/40'
  else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400/90 bg-red-950/40'
  else if (line.startsWith('@@')) cls = 'text-indigo-400/80'
  return <div className={`font-mono text-[9px] leading-tight ${cls}`}>{line || ' '}</div>
}

function FilePatch({ file }: { file: PrDiffFile }) {
  const lines = useMemo(() => (file.patch ?? '').split('\n').slice(0, 80), [file.patch])
  return (
    <div className="mb-2 rounded border border-zinc-800 bg-zinc-950/80 p-1.5">
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="truncate font-medium text-zinc-300">{file.path}</span>
        <span className="shrink-0 text-zinc-500">
          <span className="text-emerald-500">+{file.additions}</span>{' '}
          <span className="text-red-400">−{file.deletions}</span>
        </span>
      </div>
      {lines.length > 0 ? (
        <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/40 p-1">
          {lines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </pre>
      ) : (
        <p className="mt-1 text-[9px] text-zinc-600">Binary or large file (no patch preview)</p>
      )}
    </div>
  )
}

export function OfficePrDiffPanel({
  monitor,
  onRefresh
}: {
  monitor: OfficeMonitor
  onRefresh?: () => void
}) {
  const [fileIdx, setFileIdx] = useState(0)
  const [comment, setComment] = useState('')
  const [reviewNote, setReviewNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const pr = monitor.pr
  const files = pr?.files ?? []
  const current = files[fileIdx]

  const postComment = async () => {
    if (!pr || !comment.trim()) return
    setBusy(true)
    setActionErr(null)
    try {
      await engineClient.office.prComment(pr.owner, pr.repo, pr.number, comment.trim())
      setComment('')
      onRefresh?.()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitReview = async (event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') => {
    if (!pr) return
    setBusy(true)
    setActionErr(null)
    try {
      await engineClient.office.prReview(pr.owner, pr.repo, pr.number, event, reviewNote.trim() || undefined)
      onRefresh?.()
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!pr) {
    return (
      <div className="rounded border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200/90">
        <p>No diff loaded. Set GITHUB_TOKEN for private repos, then refresh.</p>
        {monitor.url && onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 rounded border border-amber-700 px-2 py-0.5 text-[10px]"
          >
            Fetch PR diff
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="border-b border-zinc-800 pb-2">
        <p className="font-medium text-zinc-200">
          {pr.owner}/{pr.repo}#{pr.number}
        </p>
        <p className="mt-0.5 text-[10px] text-zinc-400">{pr.title}</p>
        <p className="mt-1 text-[9px] text-zinc-500">
          {pr.state} · @{pr.author} · {files.length} files
        </p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          >
            Refresh diff
          </button>
        )}
      </div>
      {files.length > 1 && (
        <select
          className="mt-2 w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-[10px]"
          value={fileIdx}
          onChange={(e) => setFileIdx(Number(e.target.value))}
        >
          {files.map((f, i) => (
            <option key={f.path} value={i}>
              {f.path}
            </option>
          ))}
        </select>
      )}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {current ? <FilePatch file={current} /> : <p className="text-zinc-600">No files in PR</p>}
      </div>
      <div className="mt-2 shrink-0 border-t border-zinc-800 pt-2">
        <p className="mb-1 text-[9px] uppercase text-zinc-600">PR actions</p>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Issue comment…"
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px]"
        />
        <button
          type="button"
          disabled={busy || !comment.trim()}
          onClick={() => void postComment()}
          className="mt-1 rounded border border-zinc-600 px-2 py-0.5 text-[10px] hover:bg-zinc-800 disabled:opacity-40"
        >
          Comment
        </button>
        <textarea
          value={reviewNote}
          onChange={(e) => setReviewNote(e.target.value)}
          rows={1}
          placeholder="Review note (optional)"
          className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px]"
        />
        <div className="mt-1 flex flex-wrap gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitReview('APPROVE')}
            className="rounded bg-emerald-800/80 px-2 py-0.5 text-[10px] text-emerald-100 disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitReview('REQUEST_CHANGES')}
            className="rounded bg-amber-900/80 px-2 py-0.5 text-[10px] text-amber-100 disabled:opacity-40"
          >
            Request changes
          </button>
        </div>
        {actionErr && <p className="mt-1 text-[9px] text-red-400">{actionErr}</p>}
      </div>
    </div>
  )
}
