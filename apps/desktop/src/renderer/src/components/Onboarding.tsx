import { engineClient } from '../lib/engine'
import { useState } from 'react'
import type { OmegaConfig } from '@omega/sdk'
import { BRAND_NAME } from '../../../shared/brand'
import { MODEL_HUB } from '../data/model-hub'
import { WelcomePythonEnvStep } from './WelcomePythonEnvStep'

type OnboardingStep = 'welcome' | 'python-env'

type PendingOnboarding = {
  defaultModel: string
  allowWebFetch: boolean
  allowBrowser: boolean
  allowShell: boolean
  allowHostFilesystem: boolean
}

export function Onboarding({ config, onDone }: { config: OmegaConfig; onDone: (c: OmegaConfig) => void }) {
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [pick, setPick] = useState(MODEL_HUB[0])
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState('')
  const [allowWeb, setAllowWeb] = useState(config.allowWebFetch)
  const [allowBrowser, setAllowBrowser] = useState(config.allowBrowser ?? false)
  const [allowShell, setAllowShell] = useState(config.allowShell)
  const [allowHostFs, setAllowHostFs] = useState(config.allowHostFilesystem ?? false)
  const [pending, setPending] = useState<PendingOnboarding | null>(null)

  const modelId = pick.file

  const goToPythonEnv = (next: PendingOnboarding) => {
    setPending(next)
    setStep('python-env')
  }

  const finishOnboarding = async () => {
    const base = pending ?? {
      defaultModel: config.defaultModel,
      allowWebFetch: allowWeb,
      allowBrowser,
      allowShell,
      allowHostFilesystem: allowHostFs
    }
    const patch = {
      defaultModel: base.defaultModel,
      allowWebFetch: base.allowWebFetch,
      allowBrowser: base.allowBrowser,
      allowShell: base.allowShell,
      allowHostFilesystem: base.allowHostFilesystem,
      onboardingComplete: true
    }
    onDone({ ...config, ...patch })
    await engineClient.config.set(patch)
  }

  const skipModelDownload = () => {
    goToPythonEnv({
      defaultModel: config.defaultModel,
      allowWebFetch: allowWeb,
      allowBrowser,
      allowShell,
      allowHostFilesystem: allowHostFs
    })
  }

  const downloadAndContinue = async () => {
    setDownloading(true)
    setProgress('Starting download…')
    const off = engineClient.models.onDownloadProgress((p) => {
      const prog = p as { percent?: number; status?: string; filename?: string }
      setProgress(`${prog.status ?? ''} ${prog.percent?.toFixed(0) ?? 0}% — ${prog.filename ?? ''}`)
    })
    try {
      await engineClient.models.download(pick.repo, pick.file)
      await engineClient.inference.switch(modelId)
      goToPythonEnv({
        defaultModel: modelId,
        allowWebFetch: allowWeb,
        allowBrowser,
        allowShell,
        allowHostFilesystem: allowHostFs
      })
    } catch (e) {
      setProgress(e instanceof Error ? e.message : String(e))
    } finally {
      off()
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-8 shadow-2xl">
        {step === 'welcome' ? (
          <>
            <h2 className="text-2xl font-bold text-indigo-400">Welcome to {BRAND_NAME}</h2>
            <p className="mt-3 text-sm text-zinc-400">
              A local AI OS: chat, agents, memory, and tools on your machine. Pick a starter model
              (optional), then Omega will set up the shared Python environment before the app opens.
            </p>

            <section className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Starter model (optional)
              </p>
              <div className="mt-2 space-y-2">
                {MODEL_HUB.slice(0, 4).map((h) => (
                  <label
                    key={h.id}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${pick.id === h.id ? 'border-indigo-500 bg-indigo-950/30' : 'border-zinc-700'}`}
                  >
                    <input
                      type="radio"
                      name="model"
                      checked={pick.id === h.id}
                      disabled={downloading}
                      onChange={() => setPick(h)}
                    />
                    <div>
                      <p className="text-sm font-medium">{h.name}</p>
                      <p className="text-xs text-zinc-500">
                        {h.params} · {h.quant}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
              {progress && <p className="mt-2 text-xs text-amber-300/90">{progress}</p>}
            </section>

            <section className="mt-6 space-y-2 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Agent permissions
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowWeb}
                  disabled={downloading}
                  onChange={(e) => setAllowWeb(e.target.checked)}
                />
                Allow web fetch tool
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowBrowser}
                  disabled={downloading}
                  onChange={(e) => setAllowBrowser(e.target.checked)}
                />
                Allow built-in browser (agents can navigate pages)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowShell}
                  disabled={downloading}
                  onChange={(e) => setAllowShell(e.target.checked)}
                />
                Allow shell tool (run commands on your system)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowHostFs}
                  disabled={downloading}
                  onChange={(e) => setAllowHostFs(e.target.checked)}
                />
                Host filesystem (read/write files anywhere via absolute paths)
              </label>
            </section>

            <div className="mt-8 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={skipModelDownload}
                disabled={downloading}
                className="rounded-lg border border-zinc-600 px-5 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
              >
                Skip model download
              </button>
              <button
                type="button"
                onClick={() => void downloadAndContinue()}
                disabled={downloading}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium disabled:opacity-40"
              >
                {downloading ? 'Downloading…' : 'Download & continue'}
              </button>
            </div>
          </>
        ) : (
          <WelcomePythonEnvStep
            onReady={finishOnboarding}
            title="Almost ready"
            subtitle="Setting up the shared Python environment at %USERPROFILE%\.omega\venvs\unified. Requires Python 3.10+ on your PATH. This is the last step before the app opens."
          />
        )}
      </div>
    </div>
  )
}
