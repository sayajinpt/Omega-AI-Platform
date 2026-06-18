import { useEffect, useRef, useState } from 'react'
import type { ContentStudioSetupProgress } from '@omega/sdk'
import { engineClient } from '../lib/engine'
import { markPythonEnvSatisfied } from '../lib/use-python-env-gate'
import { ContentStudioSetupPanel } from './ContentStudioSetupPanel'

export function WelcomePythonEnvStep({
  onReady,
  title,
  subtitle
}: {
  onReady: () => void | Promise<void>
  title: string
  subtitle: string
}) {
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [progress, setProgress] = useState<ContentStudioSetupProgress | null>(null)
  const [skipSetup, setSkipSetup] = useState(false)
  const finishedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      while (!cancelled) {
        try {
          const st = await engineClient.runtime.status()
          if (st.state === 'ready' || st.state === 'running') {
            if (!cancelled) setRuntimeReady(true)
            return
          }
        } catch {
          /* wait for runtime */
        }
        await new Promise((r) => setTimeout(r, 800))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!runtimeReady || finishedRef.current) return
    void engineClient.contentStudio.status().then((st) => {
      if (finishedRef.current) return
      if (st.apiPackagesReady === true && !st.setupRunning) {
        finishedRef.current = true
        setSkipSetup(true)
        markPythonEnvSatisfied()
        void onReady()
      }
    })
  }, [runtimeReady, onReady])

  useEffect(() => {
    if (!runtimeReady) return
    return engineClient.contentStudio.onSetupProgress((p) => setProgress(p))
  }, [runtimeReady])

  useEffect(() => {
    if (!runtimeReady || finishedRef.current || skipSetup || !progress) return
    if (progress.error) return
    if (progress.running || progress.percent !== 100) return
    finishedRef.current = true
    markPythonEnvSatisfied()
    void onReady()
  }, [runtimeReady, skipSetup, progress, onReady])

  return (
    <>
      <h2 className="text-2xl font-bold text-indigo-400">{title}</h2>
      <p className="mt-3 text-sm text-zinc-400">{subtitle}</p>
      {!runtimeReady && (
        <p className="mt-6 text-sm text-zinc-500">Waiting for Omega runtime…</p>
      )}
      {runtimeReady && !skipSetup && (
        <div className="mt-6">
          <ContentStudioSetupPanel variant="welcome" autoStart progress={progress} />
        </div>
      )}
    </>
  )
}
