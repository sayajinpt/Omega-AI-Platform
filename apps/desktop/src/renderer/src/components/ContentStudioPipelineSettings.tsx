import { useCallback, useEffect, useState } from 'react'
import type { ContentStudioGenerationSettings } from '@omega/sdk'
import { engineClient } from '../lib/engine'

type MediaCaps = {
  imageGenerate?: boolean
  ttsGenerate?: boolean
  vision?: boolean
  llamaCliPresent?: boolean
  inferAvailable?: boolean
  policy?: string
  imageBackend?: string
  imageAccelerator?: string
  ttsAccelerator?: string
  videoAccelerator?: string
  studioSubprocess?: { pythonReady?: boolean; scriptReady?: boolean; backendReady?: boolean }
  contentStudioGeneration?: {
    accelerators?: {
      image?: { label?: string; accelerator?: string; message?: string }
      tts?: { label?: string; accelerator?: string }
      video?: { label?: string; accelerator?: string }
      directmlInstalled?: boolean
      directmlWorks?: boolean
      cudaWorks?: boolean
    }
  }
}

function accelPillClass(id: string | undefined): string {
  if (id === 'cuda') return 'text-emerald-400'
  if (id === 'directml') return 'text-sky-400'
  if (id === 'cpu') return 'text-amber-400'
  return 'text-zinc-400'
}

function accelLabel(
  caps: MediaCaps | null,
  kind: 'image' | 'tts' | 'video'
): { id: string; label: string; hint?: string } {
  const acc = caps?.contentStudioGeneration?.accelerators
  const row = acc?.[kind]
  const id =
    row?.accelerator ??
    (kind === 'image'
      ? caps?.imageAccelerator
      : kind === 'tts'
        ? caps?.ttsAccelerator
        : caps?.videoAccelerator) ??
    'cpu'
  const label = row?.label ?? (id === 'cuda' ? 'CUDA' : id === 'directml' ? 'DirectML' : 'CPU')
  const hint = kind === 'image' ? acc?.image?.message : undefined
  return { id, label, hint }
}

export function ContentStudioPipelineSettings() {
  const [gen, setGen] = useState<ContentStudioGenerationSettings | null>(null)
  const [caps, setCaps] = useState<MediaCaps | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [syncWarning, setSyncWarning] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(() => {
    setLoadErr('')
    void engineClient.contentStudio.generation
      .get()
      .then((g) => setGen(g))
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
    void engineClient.inference
      .mediaCapabilities()
      .then((c) => setCaps(c as MediaCaps))
      .catch(() => setCaps(null))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const save = async () => {
    if (!gen) return
    setSaving(true)
    setSyncWarning('')
    try {
      const out = await engineClient.contentStudio.generation.set(gen)
      setGen(out)
      const warn = (out as { syncWarning?: string }).syncWarning
      if (warn) setSyncWarning(warn)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      void engineClient.contentStudio.credentials.sync().catch(() => {})
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const preferNative = gen?.preferNativeMedia !== false

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-zinc-400">Content Studio — render pipeline</p>
        <button
          type="button"
          className="text-[10px] text-indigo-400 hover:text-indigo-300"
          onClick={() => reload()}
        >
          Refresh status
        </button>
      </div>

      <p className="text-[10px] text-zinc-600 leading-relaxed">
        Native path is orchestrated by omega-runtime: engine/Ollama first, then automatic
        diffusers/Qwen subprocess fallback when a phase produces no usable output, then ffmpeg.
      </p>

      {caps && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-zinc-500">
          <span>TTS (engine)</span>
          <span className={caps.ttsGenerate ? 'text-emerald-400' : 'text-amber-400'}>
            {caps.ttsGenerate ? 'ready' : 'needs llama-cli next to omega-infer'}
          </span>
          <span>Scene images</span>
          <span className={accelPillClass(accelLabel(caps, 'image').id)}>
            {accelLabel(caps, 'image').label}
          </span>
          <span>Content Studio TTS</span>
          <span className={accelPillClass(accelLabel(caps, 'tts').id)}>
            {accelLabel(caps, 'tts').label}
          </span>
          <span>Content Studio video</span>
          <span className={accelPillClass(accelLabel(caps, 'video').id)}>
            {accelLabel(caps, 'video').label}
          </span>
          <span>Ollama (opt-in)</span>
          <span
            className={
              (caps as { ollamaImageAvailable?: boolean }).ollamaImageAvailable
                ? 'text-emerald-400'
                : 'text-zinc-500'
            }
          >
            {(caps as { ollamaImageAvailable?: boolean }).ollamaImageAvailable
              ? 'available'
              : 'off unless running'}
          </span>
          <span>Chat vision</span>
          <span>{caps.vision ? 'yes' : 'no'}</span>
          {caps.studioSubprocess && (
            <>
              <span>Studio subprocess</span>
              <span
                className={
                  caps.studioSubprocess.pythonReady &&
                  caps.studioSubprocess.scriptReady &&
                  caps.studioSubprocess.backendReady
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }
              >
                {caps.studioSubprocess.pythonReady &&
                caps.studioSubprocess.scriptReady &&
                caps.studioSubprocess.backendReady
                  ? 'ready'
                  : 'needs python setup / packaged backend'}
              </span>
            </>
          )}
        </div>
      )}

      {caps?.contentStudioGeneration?.accelerators?.image?.message && (
        <p className="text-[10px] text-zinc-600 leading-relaxed">
          {caps.contentStudioGeneration.accelerators.image.message}
          {caps.contentStudioGeneration.accelerators.directmlInstalled === false &&
          caps.contentStudioGeneration.accelerators.cudaWorks === false ? (
            <>
              {' '}
              On AMD/Intel Windows, re-run Python setup to install{' '}
              <span className="text-zinc-500">torch-directml</span>.
            </>
          ) : null}
        </p>
      )}

      {loadErr && <p className="text-xs text-red-400">{loadErr}</p>}

      {gen && (
        <>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preferNative}
              onChange={(e) =>
                setGen((g) => (g ? { ...g, preferNativeMedia: e.target.checked } : g))
              }
            />
            <span>
              Prefer native media pipeline
              <span className="mt-0.5 block text-[10px] font-normal text-zinc-600">
                When enabled (default), all deliverables go through omega-runtime native render.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={Boolean(gen.reloadChatModelAfterJob)}
              onChange={(e) =>
                setGen((g) => (g ? { ...g, reloadChatModelAfterJob: e.target.checked } : g))
              }
            />
            <span>
              Reload chat model after Content Studio jobs
              <span className="mt-0.5 block text-[10px] font-normal text-zinc-600">
                When off, the chat model stays unloaded after max-performance renders until you
                send another message.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save pipeline settings'}
            </button>
            {saved && <span className="text-xs text-emerald-400">Saved</span>}
          </div>
          {syncWarning && (
            <p className="text-[10px] text-amber-400">
              Saved locally; Content Studio API sync: {syncWarning}
            </p>
          )}
        </>
      )}
    </div>
  )
}
