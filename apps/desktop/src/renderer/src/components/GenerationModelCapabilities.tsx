import { useEffect, useState } from 'react'
import type { GenerationCapabilities } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export function GenerationModelCapabilities({
  modality,
  repoId
}: {
  modality: 'tts' | 'image' | 'video'
  repoId: string
}) {
  const [caps, setCaps] = useState<GenerationCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const pin = repoId.trim()
    if (!pin) {
      setCaps(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void engineClient.contentStudio.generation
      .capabilities(modality, pin)
      .then((result) => {
        if (!cancelled) setCaps(result)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setCaps(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [modality, repoId])

  if (!repoId.trim()) return null

  if (loading && !caps) {
    return <p className="mt-1 text-[10px] text-zinc-600">Probing model capabilities…</p>
  }

  if (error) {
    return <p className="mt-1 text-[10px] text-amber-500/90">Capability probe failed: {error}</p>
  }

  if (!caps) return null

  const controlLabels = caps.controls
    .filter((c) => !c.advanced)
    .map((c) => c.label)
    .slice(0, 8)

  return (
    <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[10px] text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-zinc-500">Family:</span>
        <span className="text-zinc-300">{caps.family}</span>
        {!caps.on_disk && (
          <span className="rounded bg-amber-950/50 px-1 py-0.5 text-amber-400/90">not on disk</span>
        )}
        {caps.backend_supported ? (
          <span className="rounded bg-emerald-950/50 px-1 py-0.5 text-emerald-400/90">supported</span>
        ) : (
          <span className="rounded bg-red-950/50 px-1 py-0.5 text-red-400/90">unsupported</span>
        )}
      </div>
      {!caps.backend_supported && caps.unsupported_reason && (
        <p className="mt-1 text-amber-500/90">{caps.unsupported_reason}</p>
      )}
      {caps.backend_supported && controlLabels.length > 0 && (
        <p className="mt-1 text-zinc-500">
          Supported controls:{' '}
          <span className="text-zinc-300">{controlLabels.join(' · ')}</span>
          {caps.controls.length > controlLabels.length ? ' …' : ''}
        </p>
      )}
    </div>
  )
}
