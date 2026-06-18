import { useCallback, useState } from 'react'
import {
  describeModelLoadResult,
  formatModelLoadProgress,
  modelIdsMatch,
  normalizeModelId,
  type ModelLoadCommandResult
} from '@omega/sdk'
import { engineClient, refreshRuntimeSnapshot } from './client'

export interface UseModelLoadOptions {
  onRefresh?: () => void
  onError?: (message: string) => void
  /** Set defaultModel after successful load (default true). */
  setAsDefault?: boolean
  autoClearStatusMs?: number
}

export function useModelLoad(options: UseModelLoadOptions = {}) {
  const { onRefresh, onError, setAsDefault = true, autoClearStatusMs = 0 } = options
  const [busy, setBusy] = useState(false)
  const [percent, setPercent] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const clearTransientStatus = useCallback(() => {
    if (autoClearStatusMs <= 0) return
    setTimeout(() => {
      setStatus(null)
      setPercent(0)
    }, autoClearStatusMs)
  }, [autoClearStatusMs])

  const load = useCallback(
    async (
      id: string,
      loadOpts?: { isRemote?: boolean; style?: 'default' | 'installed' }
    ): Promise<ModelLoadCommandResult | undefined> => {
      const norm = normalizeModelId(id)
      setBusy(true)
      setError(null)
      setPercent(0)
      setStatus(`Loading ${norm}…`)
      const off = engineClient.models.onLoadProgress((p) => {
        if (!modelIdsMatch(p.modelId, norm)) return
        const formatted = formatModelLoadProgress(p)
        setPercent(formatted.percent)
        setStatus(formatted.status)
      })
      try {
        const res = await engineClient.models.load(norm)
        if (setAsDefault) {
          await engineClient.config.set({ defaultModel: norm })
        }
        await refreshRuntimeSnapshot()
        onRefresh?.()
        setPercent(100)
        setStatus(
          describeModelLoadResult(res, norm, {
            isRemote: loadOpts?.isRemote,
            style: loadOpts?.style
          })
        )
        clearTransientStatus()
        return res
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        setStatus(null)
        setPercent(0)
        onError?.(msg)
        throw e
      } finally {
        off()
        setBusy(false)
      }
    },
    [clearTransientStatus, onError, onRefresh, setAsDefault]
  )

  const unload = useCallback(
    async (id: string): Promise<void> => {
      const norm = normalizeModelId(id)
      setBusy(true)
      setError(null)
      setPercent(0)
      setStatus(`Unloading ${norm}…`)
      try {
        await engineClient.models.unload(norm)
        await refreshRuntimeSnapshot()
        onRefresh?.()
        setStatus(`Unloaded ${norm}`)
        clearTransientStatus()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        setStatus(null)
        setPercent(0)
        onError?.(msg)
        throw e
      } finally {
        setBusy(false)
      }
    },
    [clearTransientStatus, onError, onRefresh]
  )

  return { load, unload, busy, percent, status, error, setStatus, setPercent }
}
