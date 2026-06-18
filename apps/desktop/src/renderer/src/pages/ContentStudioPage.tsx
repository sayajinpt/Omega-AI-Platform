import { engineClient } from '../lib/engine'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ContentSchedule,
  ContentSeries,
  ContentSocialAccount,
  ContentSocialPlatform,
  ContentSocialPost,
  ContentStudioProject,
  ContentStudioRun,
  ContentStudioRunStatus,
  ContentStudioSetupProgress,
  ContentStudioStatus,
  OmegaConfig
} from '@omega/sdk'

import { CollapsibleSection } from '../components/CollapsibleSection'
import { ContentStudioSetupPanel } from '../components/ContentStudioSetupPanel'
import { readContentStudioFocus, clearContentStudioFocus } from '../components/ContentStudioMessageCard'

const PIPELINE_MODES = [
  { id: 'script_only', label: 'Script only' },
  { id: 'local_media', label: 'Script + local media (TTS/images/video)' },
  { id: 'full_publish', label: 'Full pipeline + publish' }
] as const

const SOCIAL_PLATFORMS = [
  'youtube',
  'tiktok',
  'instagram',
  'x',
  'facebook',
  'linkedin',
  'threads'
]

const CONTENT_AGENT_PROMPT = `You are the Omega Content Studio agent. Help create and schedule video content and cross-post to social platforms.
Tools: content_create_run, content_run_status, content_list_projects, content_series_list, content_series_create, content_schedule_create, content_schedule_list, content_social_publish, content_social_platforms.
Use pipeline_mode script_only for outlines, local_media for rendered video, full_publish when YouTube/social is connected. Schedules accept project_id or series_id.
When generation is in agent_orchestrated mode: load only the models needed per step (script, TTS, image), then unload them to free VRAM before the next step.`

function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['projects', 'series', 'schedules', 'platforms', 'accounts', 'posts', 'items']) {
      if (Array.isArray(obj[key])) return obj[key] as T[]
    }
  }
  return []
}

function normalizeSetupProgress(
  p: ContentStudioSetupProgress
): ContentStudioSetupProgress {
  return { ...p, steps: Array.isArray(p.steps) ? p.steps : [] }
}

export function ContentStudioPage({
  config,
  active = true
}: {
  config: OmegaConfig
  /** False when another nav page is selected (panel stays mounted to preserve state). */
  active?: boolean
}) {
  const [status, setStatus] = useState<ContentStudioStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [setupProgress, setSetupProgress] = useState<ContentStudioSetupProgress | null>(null)
  const [apiStarting, setApiStarting] = useState(false)
  const autoStartLock = useRef(false)
  const [projects, setProjects] = useState<ContentStudioProject[]>([])
  const [seriesList, setSeriesList] = useState<ContentSeries[]>([])
  const [schedules, setSchedules] = useState<ContentSchedule[]>([])
  const [platforms, setPlatforms] = useState<ContentSocialPlatform[]>([])
  const [accounts, setAccounts] = useState<ContentSocialAccount[]>([])
  const [posts, setPosts] = useState<ContentSocialPost[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<ContentStudioRun | null>(null)
  const [pollJobId, setPollJobId] = useState('')
  const [pollStatus, setPollStatus] = useState<ContentStudioRunStatus | null>(null)

  const [title, setTitle] = useState('')
  const [theme, setTheme] = useState('')
  const [episodeTopic, setEpisodeTopic] = useState('')
  const [pipelineMode, setPipelineMode] = useState<(typeof PIPELINE_MODES)[number]['id']>('script_only')

  const [cronExpr, setCronExpr] = useState('0 9 * * 1')
  const [scheduleProjectId, setScheduleProjectId] = useState('')
  const [scheduleSeriesId, setScheduleSeriesId] = useState('')

  const [seriesTitle, setSeriesTitle] = useState('')
  const [seriesTheme, setSeriesTheme] = useState('')
  const [seriesMaxDuration, setSeriesMaxDuration] = useState('600')

  const [socialPlatform, setSocialPlatform] = useState('youtube')
  const [socialTitle, setSocialTitle] = useState('')
  const [socialCaption, setSocialCaption] = useState('')
  const [socialProjectId, setSocialProjectId] = useState('')

  const [agentMode, setAgentMode] = useState(false)
  const [agentInput, setAgentInput] = useState('')
  const refresh = useCallback(async () => {
    setError(null)
    let st: ContentStudioStatus
    try {
      st = await engineClient.contentStudio.status()
      setStatus(st)
    } catch (e) {
      setStatusLoading(false)
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      setStatusLoading(false)
    }
    if (!st.available || !st.venvReady || !st.running) {
      setProjects([])
      setSeriesList([])
      setSchedules([])
      setPlatforms([])
      setAccounts([])
      setPosts([])
      return
    }
    if (st.available && st.running) {
      const [p, ser, s, pl, ac, po] = await Promise.allSettled([
        engineClient.contentStudio.listProjects(),
        engineClient.contentStudio.listSeries(),
        engineClient.contentStudio.listSchedules(),
        engineClient.contentStudio.socialPlatforms(),
        engineClient.contentStudio.socialAccounts(),
        engineClient.contentStudio.socialPosts()
      ])
      if (p.status === 'fulfilled') setProjects(asList(p.value))
      if (ser.status === 'fulfilled') setSeriesList(asList(ser.value))
      if (s.status === 'fulfilled') setSchedules(asList(s.value))
      if (pl.status === 'fulfilled') setPlatforms(asList(pl.value))
      if (ac.status === 'fulfilled') setAccounts(asList(ac.value))
      else if (ac.status === 'rejected') setAccounts([])
      if (po.status === 'fulfilled') setPosts(asList(po.value))
      const failed = [p, ser, s, pl, ac, po].find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined
      if (failed) {
        setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [active, refresh])

  useEffect(() => {
    return engineClient.contentStudio.onChanged(() => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    const off = engineClient.contentStudio.onSetupProgress((p) =>
      setSetupProgress(normalizeSetupProgress(p))
    )
    return off
  }, [])

  const setupInProgress = Boolean(status?.setupRunning || setupProgress?.running)

  useEffect(() => {
    if (!setupInProgress) return
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [setupInProgress, refresh])

  /** Venv exists but API was never started (or stopped) — start automatically when user opens this page. */
  useEffect(() => {
    if (
      !active ||
      !status?.venvReady ||
      status.apiPackagesReady !== true ||
      status.running ||
      status.setupRunning ||
      setupInProgress ||
      autoStartLock.current
    )
      return
    autoStartLock.current = true
    setApiStarting(true)
    setError(null)
    void engineClient.contentStudio
      .start()
      .then(() => refresh())
      .catch((e) => {
        autoStartLock.current = false
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setApiStarting(false))
  }, [active, status?.venvReady, status?.apiPackagesReady, status?.running, status?.setupRunning, setupInProgress, refresh])

  useEffect(() => {
    if (status?.venvReady) return
    autoStartLock.current = false
  }, [status?.venvReady])

  useEffect(() => {
    const focus = readContentStudioFocus()
    if (!focus) return
    setPollJobId(focus.jobId)
    clearContentStudioFocus()
    void refresh()
  }, [refresh])

  const generate = async () => {
    if (!theme.trim()) {
      setError('Theme is required for a new project.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const run = await engineClient.contentStudio.createRun({
        title: title.trim() || undefined,
        theme: theme.trim(),
        episode_topic: episodeTopic.trim() || undefined,
        pipeline_mode: pipelineMode
      })
      setLastRun(run)
      setPollJobId(run.job_id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pollRun = async () => {
    if (!pollJobId.trim()) return
    setBusy(true)
    try {
      const st = await engineClient.contentStudio.runStatus(pollJobId.trim())
      setPollStatus(st)
      setError(st.error_message ?? null)
    } catch (e) {
      setPollStatus(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const createSeries = async () => {
    if (!seriesTitle.trim() || !seriesTheme.trim()) {
      setError('Series title and theme are required.')
      return
    }
    setBusy(true)
    try {
      await engineClient.contentStudio.createSeries({
        title: seriesTitle.trim(),
        theme: seriesTheme.trim(),
        default_max_duration_seconds: parseInt(seriesMaxDuration, 10) || 600
      })
      setSeriesTitle('')
      setSeriesTheme('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeSeries = async (id: string) => {
    setBusy(true)
    try {
      await engineClient.contentStudio.deleteSeries(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addSchedule = async () => {
    const projectId = scheduleProjectId.trim()
    const seriesId = scheduleSeriesId.trim()
    if (!projectId && !seriesId) {
      setError('Pick a project id or series id for the schedule.')
      return
    }
    setBusy(true)
    try {
      await engineClient.contentStudio.createSchedule({
        project_id: projectId || undefined,
        series_id: seriesId || undefined,
        cron_expression: cronExpr.trim(),
        timezone: 'UTC'
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const publishSocial = async () => {
    if (!socialTitle.trim()) {
      setError('Social post title is required.')
      return
    }
    setBusy(true)
    try {
      await engineClient.contentStudio.socialPublish({
        platform: socialPlatform,
        title: socialTitle.trim(),
        caption: socialCaption.trim() || undefined,
        project_id: socialProjectId.trim() || undefined,
        publish_now: true
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runAgent = async () => {
    if (!agentInput.trim() || !config.defaultModel) return
    setAgentMode(true)
    try {
      await engineClient.agent.run({
        model: config.defaultModel,
        input: `${CONTENT_AGENT_PROMPT}\n\nUser: ${agentInput.trim()}`,
        maxSteps: 10
      })
    } finally {
      setAgentMode(false)
    }
  }

  if (statusLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6 text-zinc-200">
        <h2 className="text-xl font-semibold text-white">Content Studio</h2>
        <p className="mt-2 text-sm text-zinc-500">Checking Python environment…</p>
      </div>
    )
  }

  if (!status?.available) {
    return (
      <div className="p-6 text-zinc-300">
        <h2 className="text-lg font-semibold text-white">Content Studio</h2>
        <p className="mt-2 text-sm text-amber-400">
          Content Studio is not installed in this build. Reinstall Omega, or from a dev checkout run{' '}
          <code className="text-indigo-300">build.bat</code> from the Omega source folder.
        </p>
        {status?.error && (
          <p className="mt-1 text-xs text-zinc-500">{status.error}</p>
        )}
      </div>
    )
  }

  const envReady =
    status.venvReady && status.apiPackagesReady === true && status.mediaPackagesReady === true
  const needsEnvSetup = !envReady && !setupInProgress
  const needsApi = envReady && !status.running && !setupInProgress

  if (setupInProgress) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6 text-zinc-200">
        <h2 className="text-xl font-semibold text-white">Content Studio</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Installing the Python environment. You can switch tabs — setup continues. Return here when
          the progress bar finishes.
        </p>
        <div className="mt-8 flex flex-1 items-start justify-center">
          <ContentStudioSetupPanel
            autoStart={false}
            setupComplete={envReady}
            progress={setupProgress}
            setupRunning={status.setupRunning}
          />
        </div>
      </div>
    )
  }

  if (needsEnvSetup) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6 text-zinc-200">
        <h2 className="text-xl font-semibold text-white">Content Studio</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Video projects, generation pipeline, schedules, and multi-platform social publishing.
        </p>
        <div className="mt-8 flex flex-1 items-start justify-center">
          <ContentStudioSetupPanel
            setupComplete={envReady}
            progress={setupProgress}
            setupRunning={status.setupRunning}
            onComplete={() => void refresh()}
          />
        </div>
      </div>
    )
  }

  if (needsApi) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6 text-zinc-200">
        <h2 className="text-xl font-semibold text-white">Content Studio</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Python environment is ready. Preparing Content Studio…
        </p>
        <div className="mx-auto mt-8 max-w-lg rounded-xl border border-zinc-800 bg-zinc-900/80 p-6 text-center">
          {apiStarting ? (
            <p className="text-sm text-zinc-300">Preparing Content Studio…</p>
          ) : (
            <>
              <p className="text-sm text-zinc-400">
                The API is not running. If you just finished environment setup, click below to start
                the database and API.
              </p>
              <button
                type="button"
                className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
                onClick={() => {
                  autoStartLock.current = true
                  setApiStarting(true)
                  void engineClient.contentStudio
                    .start()
                    .then(() => refresh())
                    .catch((e) => {
                      autoStartLock.current = false
                      setError(e instanceof Error ? e.message : String(e))
                    })
                    .finally(() => setApiStarting(false))
                }}
              >
                Start Content Studio API
              </button>
            </>
          )}
          {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden p-6 text-zinc-200">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Content Studio</h2>
          <p className="text-sm text-zinc-500">
            Video projects, generation pipeline, schedules, and multi-platform social publishing.
          </p>
        </div>
        <span
          className={`rounded px-2 py-1 text-xs ${status.running ? 'bg-emerald-900/50 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}
        >
          {status.running
            ? status.mode === 'on-demand'
              ? 'ready'
              : `API :${status.port}`
            : 'stopped'}
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          <p>{error}</p>
          <button
            type="button"
            className="mt-2 rounded border border-red-700 px-2 py-1 text-xs hover:bg-red-900/50"
            onClick={() => void engineClient.contentStudio.restart().then(() => refresh())}
          >
            Restart Content Studio API
          </button>
        </div>
      )}

      <p className="mb-4 text-xs text-zinc-500">
        TTS, txt-to-img, and assistant models: Settings → Omega tools.
      </p>

      <CollapsibleSection title="Generate content" defaultOpen minBodyHeight={200} maxBodyHeight={400}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            Title
            <input
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Pipeline
            <select
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
              value={pipelineMode}
              onChange={(e) => setPipelineMode(e.target.value as typeof pipelineMode)}
            >
              {PIPELINE_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-full block text-sm">
            Theme / niche *
            <input
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="e.g. daily stoic wisdom for creators"
            />
          </label>
          <label className="col-span-full block text-sm">
            Episode topic (optional)
            <input
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
              value={episodeTopic}
              onChange={(e) => setEpisodeTopic(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void generate()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Generate'}
          </button>
          {lastRun?.job_id && (
            <span className="text-xs text-zinc-500">
              Job {lastRun.job_id.slice(0, 8)}… — {lastRun.status}
            </span>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            placeholder="Job id to poll"
            value={pollJobId}
            onChange={(e) => setPollJobId(e.target.value)}
          />
          <button
            type="button"
            className="rounded border border-zinc-600 px-3 py-1 text-sm"
            onClick={() => void pollRun()}
          >
            Poll status
          </button>
        </div>
        {pollStatus && (
          <div className="mt-3 rounded border border-zinc-700 bg-zinc-950/80 p-3 text-xs">
            <p className="text-zinc-300">
              Status: <span className="font-medium">{pollStatus.status}</span>
              {pollStatus.script_ready ? ' · script ready' : ''}
              {pollStatus.video_ready ? ' · video ready' : ''}
            </p>
            {pollStatus.logs && pollStatus.logs.length > 0 ? (
              <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto font-mono text-zinc-500">
                {pollStatus.logs.slice(-40).map((line, i) => (
                  <li
                    key={`${i}-${line.message.slice(0, 24)}`}
                    className={line.level === 'warning' || line.level === 'error' ? 'text-amber-400/90' : ''}
                  >
                    [{line.level}] {line.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-zinc-600">No job log lines yet — poll again while the job is running.</p>
            )}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title={`Series (${seriesList.length})`} defaultOpen minBodyHeight={200} maxBodyHeight={360}>
        <p className="mb-2 text-xs text-zinc-500">
          Recurring shows with shared theme. Schedules can target a series id for automatic episode
          generation.
        </p>
        <div className="grid gap-2 md:grid-cols-3">
          <input
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            placeholder="Series title"
            value={seriesTitle}
            onChange={(e) => setSeriesTitle(e.target.value)}
          />
          <input
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm md:col-span-2"
            placeholder="Theme / niche"
            value={seriesTheme}
            onChange={(e) => setSeriesTheme(e.target.value)}
          />
          <input
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            placeholder="Max duration (sec)"
            value={seriesMaxDuration}
            onChange={(e) => setSeriesMaxDuration(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="mt-2 rounded border border-zinc-600 px-3 py-1.5 text-sm"
          disabled={busy}
          onClick={() => void createSeries()}
        >
          Create series
        </button>
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-sm">
          {seriesList.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-2 rounded bg-zinc-900/80 px-2 py-1.5">
              <div className="min-w-0">
                <span className="font-medium text-zinc-200">{s.title}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  ep #{s.next_episode_number ?? 1} · {s.default_max_duration_seconds}s
                </span>
                <div className="truncate text-xs text-zinc-600">{s.theme}</div>
                <div className="truncate font-mono text-xs text-zinc-700">{s.id}</div>
              </div>
              <button
                type="button"
                className="shrink-0 text-xs text-red-400 hover:text-red-300"
                onClick={() => void removeSeries(s.id)}
              >
                Delete
              </button>
            </li>
          ))}
          {!seriesList.length && <li className="text-zinc-500">No series yet.</li>}
        </ul>
      </CollapsibleSection>

      <CollapsibleSection title={`Projects (${projects.length})`} minBodyHeight={160} maxBodyHeight={320}>
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
          {projects.map((p) => (
            <li key={p.id} className="rounded bg-zinc-900/80 px-2 py-1.5">
              <span className="font-medium text-zinc-200">{p.title}</span>
              <span className="ml-2 text-xs text-zinc-500">{p.status}</span>
              <div className="truncate text-xs text-zinc-600">{p.id}</div>
            </li>
          ))}
          {!projects.length && <li className="text-zinc-500">No projects yet.</li>}
        </ul>
      </CollapsibleSection>

      <CollapsibleSection title="Schedules" minBodyHeight={160} maxBodyHeight={320}>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            placeholder="Project id (optional)"
            value={scheduleProjectId}
            onChange={(e) => setScheduleProjectId(e.target.value)}
            list="content-project-ids"
          />
          <select
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            value={scheduleSeriesId}
            onChange={(e) => setScheduleSeriesId(e.target.value)}
          >
            <option value="">Series (optional)</option>
            {seriesList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <input
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm md:col-span-2"
            placeholder="Cron (0 9 * * 1)"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
          />
        </div>
        <datalist id="content-project-ids">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          className="mt-2 rounded border border-zinc-600 px-3 py-1.5 text-sm"
          onClick={() => void addSchedule()}
        >
          Add schedule
        </button>
        <ul className="mt-3 max-h-32 space-y-1 overflow-y-auto text-sm">
          {schedules.map((s) => (
            <li key={s.id} className="rounded bg-zinc-900/60 px-2 py-1">
              <code className="text-indigo-300">{s.cron_expression}</code>
              <span className="ml-2 text-zinc-500">{s.is_active ? 'active' : 'paused'}</span>
              {(s.series_id || s.project_id) && (
                <span className="ml-2 text-xs text-zinc-600">
                  {s.series_id ? `series ${s.series_id.slice(0, 8)}…` : `project ${s.project_id?.slice(0, 8)}…`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleSection>

      <CollapsibleSection title="Social media" minBodyHeight={200} maxBodyHeight={400}>
        <p className="mb-2 text-xs text-zinc-500">
          Platforms: {platforms.map((p) => p.id).join(', ') || SOCIAL_PLATFORMS.join(', ')}. Configure API
          keys and YouTube OAuth in Settings → Content Studio (Media Automation APIs).
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <select
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            value={socialPlatform}
            onChange={(e) => setSocialPlatform(e.target.value)}
          >
            {SOCIAL_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            placeholder="Post title"
            value={socialTitle}
            onChange={(e) => setSocialTitle(e.target.value)}
          />
          <input
            className="col-span-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            placeholder="Caption (optional)"
            value={socialCaption}
            onChange={(e) => setSocialCaption(e.target.value)}
          />
          <input
            className="col-span-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            placeholder="Project id (uses rendered video when ready)"
            value={socialProjectId}
            onChange={(e) => setSocialProjectId(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="mt-2 rounded bg-violet-700 px-3 py-1.5 text-sm hover:bg-violet-600"
          onClick={() => void publishSocial()}
        >
          Queue publish
        </button>
        <ul className="mt-3 max-h-28 space-y-1 overflow-y-auto text-xs">
          {posts.map((post) => (
            <li key={post.id} className="rounded bg-zinc-900/60 px-2 py-1">
              [{post.platform}] {post.title} — <span className="text-zinc-500">{post.status}</span>
              {post.error_message && (
                <span className="block text-red-400">{post.error_message}</span>
              )}
            </li>
          ))}
        </ul>
        {accounts.length > 0 && (
          <p className="mt-2 text-xs text-zinc-600">
            Connected accounts:{' '}
            {accounts.map((a) => `${a.platform}:${a.account_label ?? a.id.slice(0, 6)}`).join(', ')}
          </p>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Agent mode">
        <textarea
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm"
          rows={3}
          value={agentInput}
          onChange={(e) => setAgentInput(e.target.value)}
          placeholder="Ask the agent to create a series, schedule weekly posts, or publish to TikTok…"
        />
        <button
          type="button"
          disabled={agentMode || !config.defaultModel}
          onClick={() => void runAgent()}
          className="mt-2 rounded bg-zinc-700 px-4 py-2 text-sm disabled:opacity-50"
        >
          {agentMode ? 'Agent running…' : 'Run with agent tools'}
        </button>
      </CollapsibleSection>
    </div>
  )
}
