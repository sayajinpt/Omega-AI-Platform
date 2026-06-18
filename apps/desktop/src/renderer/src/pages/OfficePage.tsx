import { useEffect, useState } from 'react'
import type { OfficeSnapshot, WorkforceRun } from '@omega/sdk'
import { AgentStepStrip } from '../components/AgentStepStrip'
import { OfficePrDiffPanel } from '../components/OfficePrDiffPanel'
import { OfficeJiraPanel } from '../components/OfficeJiraPanel'
import { OfficeVisualization } from '../components/OfficeVisualization'
import { engineClient } from '../lib/engine'

export function OfficePage({
  agentSteps = [],
  onClearAgentSteps,
  onOpenAgent
}: {
  agentSteps?: import('@omega/sdk').AgentStep[]
  onClearAgentSteps?: () => void
  onOpenAgent?: () => void
}) {
  const [snap, setSnap] = useState<OfficeSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkforceRun[]>([])
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(null)

  const reload = async () => {
    try {
      setSnap(await engineClient.office.snapshot())
      setRuns(await engineClient.workforce.runs())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reload()
    const offOffice = engineClient.office.onChanged((next) => {
      setSnap(next)
      setLoadError(null)
    })
    return () => {
      offOffice()
    }
  }, [])

  const selectedMonitor = snap?.monitors.find((m) => m.id === selectedMonitorId) ?? snap?.monitors[0]

  useEffect(() => {
    if (snap?.monitors.length && !selectedMonitorId) {
      setSelectedMonitorId(snap.monitors[0]!.id)
    }
  }, [snap, selectedMonitorId])

  const runMoA = async () => {
    if (!task.trim() || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const out = await engineClient.workforce.runMoA(task.trim())
      setMsg(out.slice(0, 200) + (out.length > 200 ? '…' : ''))
      await reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleStandup = async () => {
    const next = !(snap?.standupActive ?? false)
    setSnap(await engineClient.workforce.setStandup(next))
  }

  const addPrMonitor = async () => {
    const url = window.prompt('GitHub PR URL', 'https://github.com/owner/repo/pull/1')
    if (!url?.trim()) return
    setBusy(true)
    try {
      const mon = await engineClient.office.addMonitor({
        title: 'Pull request',
        kind: 'pr',
        summary: 'Loading…',
        url: url.trim()
      })
      setSelectedMonitorId(mon.id)
      await reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshMonitor = async () => {
    if (!selectedMonitor) return
    setBusy(true)
    try {
      await engineClient.office.refreshMonitor(selectedMonitor.id)
      await reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addJiraMonitor = async () => {
    const input = window.prompt('Jira issue URL or key (e.g. PROJ-123)', 'PROJ-123')
    if (!input?.trim()) return
    setBusy(true)
    try {
      const mon = await engineClient.office.addMonitor({
        title: 'Jira issue',
        kind: 'jira',
        summary: input.trim(),
        url: input.includes('/') ? input.trim() : undefined
      })
      setSelectedMonitorId(mon.id)
      await reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!snap) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-zinc-500">
        {loadError ? (
          <>
            <p className="text-sm text-rose-300">Could not load office data</p>
            <p className="max-w-md text-xs text-zinc-500">{loadError}</p>
            <button
              type="button"
              onClick={() => void reload()}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Retry
            </button>
          </>
        ) : (
          <p>Loading office…</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Office</h2>
            <p className="text-xs text-zinc-500">
              3D workforce view · agents keep working when the view is stopped
            </p>
          </div>
        </div>
      </header>

      <AgentStepStrip steps={agentSteps} onClear={onClearAgentSteps} onOpenAgent={onOpenAgent} />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col p-3">
          <OfficeVisualization compact autoStart />
        </main>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-900/50 p-4">
          <section className="mb-4">
            <h3 className="text-xs uppercase text-zinc-500">Workforce task</h3>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              placeholder="Run MoA on a goal…"
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void runMoA()}
                className="rounded bg-indigo-600 px-2 py-1 text-xs text-white disabled:opacity-40"
              >
                {busy ? 'Running…' : 'MoA run'}
              </button>
              <button
                type="button"
                onClick={() => void toggleStandup()}
                className="rounded border border-zinc-600 px-2 py-1 text-xs"
              >
                {snap.standupActive ? 'End standup' : 'Start standup'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void addPrMonitor()}
                className="rounded border border-zinc-600 px-2 py-1 text-xs"
              >
                + GitHub PR
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void addJiraMonitor()}
                className="rounded border border-zinc-600 px-2 py-1 text-xs"
              >
                + Jira issue
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    setMsg(await engineClient.office.skillGym())
                    await reload()
                  } catch (e) {
                    setMsg(e instanceof Error ? e.message : String(e))
                  } finally {
                    setBusy(false)
                  }
                }}
                className="rounded border border-violet-700 px-2 py-1 text-xs text-violet-200"
              >
                Skill gym
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    const r = await engineClient.office.officeJanitor()
                    setMsg(r.note)
                    await reload()
                  } catch (e) {
                    setMsg(e instanceof Error ? e.message : String(e))
                  } finally {
                    setBusy(false)
                  }
                }}
                className="rounded border border-zinc-600 px-2 py-1 text-xs"
              >
                Janitor
              </button>
            </div>
            {msg && <p className="mt-2 text-[10px] text-zinc-400">{msg}</p>}
          </section>

          <section className="mb-4">
            <h3 className="text-xs uppercase text-zinc-500">Monitor wall</h3>
            <div className="mt-2 min-h-[120px] rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
              {selectedMonitor?.kind === 'pr' ? (
                <OfficePrDiffPanel monitor={selectedMonitor} onRefresh={() => void refreshMonitor()} />
              ) : selectedMonitor?.kind === 'jira' ? (
                <OfficeJiraPanel monitor={selectedMonitor} onRefresh={() => void refreshMonitor()} />
              ) : (
                <p className="text-[10px] text-zinc-500">Add a GitHub PR or Jira issue monitor</p>
              )}
            </div>
          </section>

          <section className="mb-4">
            <h3 className="text-xs uppercase text-zinc-500">Monitor polling</h3>
            <label className="mt-2 flex items-center gap-2 text-[10px] text-zinc-400">
              <input
                type="checkbox"
                checked={snap.poll.enabled}
                onChange={(e) =>
                  void engineClient.office
                    .pollSet(e.target.checked, snap.poll.intervalMs)
                    .then(setSnap)
                }
              />
              Auto-refresh PR/Jira
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const n = await engineClient.office.pollRefreshAll()
                  setMsg(`Refreshed ${n} monitor(s)`)
                  await reload()
                } finally {
                  setBusy(false)
                }
              }}
              className="mt-1 rounded border border-zinc-600 px-2 py-0.5 text-[10px]"
            >
              Refresh all now
            </button>
          </section>

          {snap.kanbanPins.length > 0 && (
            <section className="mb-4">
              <h3 className="text-xs uppercase text-zinc-500">Kanban pins</h3>
              <ul className="mt-2 space-y-1">
                {snap.kanbanPins.map((p) => (
                  <li key={p.taskId} className="rounded border border-zinc-800 px-2 py-1 text-[10px]">
                    <span className="text-zinc-300">{p.title}</span>
                    <span className="ml-1 text-zinc-600">{p.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mb-4">
            <h3 className="text-xs uppercase text-zinc-500">Monitors</h3>
            <ul className="mt-2 space-y-2">
              {snap.monitors.length === 0 && (
                <li className="text-[10px] text-zinc-600">No monitors yet.</li>
              )}
              {snap.monitors.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedMonitorId(m.id)}
                    className={`w-full rounded border p-2 text-left text-xs transition ${
                      selectedMonitor?.id === m.id
                        ? 'border-indigo-600 bg-indigo-950/40'
                        : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-600'
                    }`}
                  >
                    <span className="font-medium text-zinc-300">{m.title}</span>
                    <span className="ml-1 text-[9px] uppercase text-zinc-600">{m.kind}</span>
                    <p className="mt-1 text-[10px] text-zinc-500">{m.summary}</p>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs uppercase text-zinc-500">Recent runs</h3>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {runs.slice(0, 8).map((r) => (
                <li key={r.id} className="rounded bg-zinc-950/50 px-2 py-1 text-[10px]">
                  <span className="text-zinc-400">{r.mode}</span> ·{' '}
                  <span className={r.status === 'error' ? 'text-red-400' : 'text-emerald-400'}>
                    {r.status}
                  </span>
                  <p className="truncate text-zinc-500">{r.task}</p>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
