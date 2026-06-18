import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContentStudioSetupProgress, ContentStudioSetupStep } from '@omega/sdk'
import { ModelLoadProgressBar } from './ModelLoadProgressBar'
import { engineClient } from '../lib/engine'

const STATUS_ICON: Record<ContentStudioSetupStep['status'], string> = {
  pending: '○',
  running: '◌',
  done: '✓',
  skipped: '–',
  error: '✕'
}

const STATUS_CLASS: Record<ContentStudioSetupStep['status'], string> = {
  pending: 'text-zinc-500',
  running: 'text-amber-300',
  done: 'text-emerald-400',
  skipped: 'text-zinc-500',
  error: 'text-rose-400'
}

export function ContentStudioSetupPanel({
  autoStart = true,
  variant = 'default',
  progress,
  setupRunning = false,
  setupComplete = false,
  onComplete
}: {
  autoStart?: boolean
  variant?: 'default' | 'welcome'
  progress?: ContentStudioSetupProgress | null
  setupRunning?: boolean
  setupComplete?: boolean
  onComplete?: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [setupFailed, setSetupFailed] = useState(false)
  /** One automatic attempt per mount; manual Retry resets this. */
  const attemptStartedRef = useRef(false)
  const isWelcome = variant === 'welcome'
  const setupBusy = setupRunning || Boolean(progress?.running)

  const runSetup = useCallback(async (manualRetry = false) => {
    if (manualRetry) {
      attemptStartedRef.current = false
      setSetupFailed(false)
    }
    setError(null)
    attemptStartedRef.current = true
    try {
      await engineClient.contentStudio.setupEnvironment({ profile: 'content' })
    } catch (e) {
      setSetupFailed(true)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (!autoStart || attemptStartedRef.current || setupBusy || setupComplete || setupFailed) return
    void runSetup()
  }, [autoStart, setupBusy, setupComplete, setupFailed, runSetup])

  useEffect(() => {
    if (isWelcome || setupComplete || !onComplete || setupBusy || progress?.error) return
    if (progress && !progress.running) onComplete()
  }, [isWelcome, setupComplete, onComplete, setupBusy, progress])

  useEffect(() => {
    if (!progress?.error) return
    setError(progress.error)
    setSetupFailed(true)
  }, [progress?.error])

  const steps = progress?.steps ?? []
  const showQueue =
    setupBusy || setupFailed || Boolean(progress?.error) || (steps.length > 0 && !setupComplete)

  return (
    <div
      className={
        isWelcome
          ? 'rounded-xl border border-zinc-800 bg-zinc-950/60 p-4'
          : 'mx-auto max-w-lg rounded-xl border border-indigo-800/50 bg-zinc-900/80 p-6 shadow-lg'
      }
    >
      {!isWelcome && (
        <>
          <h3 className="text-lg font-semibold text-white">Omega Python environment</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Content Studio uses the same unified Python as agent tools, sandboxes, sidecar engines,
            and finetune — not a separate venv.
          </p>
        </>
      )}

      {setupComplete && !isWelcome && (
        <p className="mt-4 text-sm text-emerald-300/90">
          Environment ready. The API starts automatically when you open Content Studio.
        </p>
      )}

      {showQueue && (
        <div className="mt-5 space-y-3">
          <ModelLoadProgressBar
            active={setupBusy}
            percent={progress?.percent ?? (setupBusy ? 5 : setupFailed ? progress?.percent ?? 0 : 0)}
            label={setupBusy ? 'Environment setup' : setupFailed ? 'Setup failed' : 'Setup'}
          />
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Setup queue
          </p>
          <ul className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            {steps.length > 0 ? (
              steps.map((step) => (
                <li key={step.id} className="flex gap-2 text-xs">
                  <span className={`w-4 shrink-0 font-mono ${STATUS_CLASS[step.status]}`}>
                    {STATUS_ICON[step.status]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={step.status === 'running' ? 'text-zinc-100' : 'text-zinc-400'}>
                      {step.label}
                    </p>
                    {step.detail && (
                      <p
                        className={`mt-0.5 text-[10px] ${
                          step.status === 'error' ? 'whitespace-pre-wrap break-words text-rose-300' : 'truncate text-zinc-600'
                        }`}
                      >
                        {step.detail}
                      </p>
                    )}
                  </div>
                </li>
              ))
            ) : (
              <li className="text-xs text-zinc-500">Preparing setup…</li>
            )}
          </ul>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/30 p-3">
          <p className="text-xs font-semibold text-rose-200">Setup could not finish</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs text-rose-300">{error}</p>
          <p className="mt-2 text-[10px] text-zinc-500">
            Full log: %USERPROFILE%\.omega\content-studio\logs\setup.log
          </p>
        </div>
      )}

      {setupFailed && !setupBusy && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void runSetup(true)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Retry setup
          </button>
        </div>
      )}
    </div>
  )
}
