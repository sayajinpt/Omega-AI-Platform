import { engineClient } from '../lib/engine'
import type {
  ContentGenerationModelEntry,
  ImageModelAdapterEntry,
  ImageSizeOverride,
  ContentGenerationRecommendedAdapter
} from '@omega/sdk'
import { HfAdapterPanel } from './HfAdapterPanel'
import { ImageResolutionControl } from './ImageResolutionControl'

export function ContentStudioImageOptions({
  baseRepoId,
  modelMeta,
  steps,
  size,
  adapters,
  onStepsChange,
  onSizeChange,
  onAdaptersChange
}: {
  /** Active image model (pinned repo or catalog default). */
  baseRepoId: string
  modelMeta?: ContentGenerationModelEntry
  steps: number
  size?: ImageSizeOverride
  adapters: ImageModelAdapterEntry[]
  onStepsChange: (steps: number) => void
  onSizeChange: (size: ImageSizeOverride | undefined) => void
  onAdaptersChange: (adapters: ImageModelAdapterEntry[]) => void
}) {
  const catalogDefault = modelMeta?.default_num_steps ?? 25
  const effectiveBase = baseRepoId.trim() || modelMeta?.repo_id || ''
  const baseAdapters = adapters.filter((a) => a.baseRepoId === effectiveBase)
  const recommended = modelMeta?.recommended_adapters ?? []

  const setStepsForBase = (value: number) => {
    onStepsChange(Math.max(0, Math.min(80, value)))
  }

  const setBaseAdapters = (rows: Array<{ repoId: string; file: string; scale?: number }>) => {
    const other = adapters.filter((a) => a.baseRepoId !== effectiveBase)
    onAdaptersChange([
      ...other,
      ...rows.map((r) => ({
        baseRepoId: effectiveBase,
        adapterRepoId: r.repoId,
        adapterFile: r.file,
        scale: r.scale ?? 1
      }))
    ])
  }

  const addRecommended = (rec: ContentGenerationRecommendedAdapter) => {
    if (!effectiveBase || !rec.repo_id) return
    if (baseAdapters.some((a) => a.adapterRepoId === rec.repo_id)) return
    onAdaptersChange([
      ...adapters.filter((a) => a.baseRepoId !== effectiveBase),
      ...baseAdapters,
      {
        baseRepoId: effectiveBase,
        adapterRepoId: rec.repo_id,
        adapterFile: rec.file,
        scale: 1
      }
    ])
  }

  if (!effectiveBase) {
    return (
      <p className="mt-2 text-[10px] text-zinc-600">
        Select or download an image model above to configure inference steps and LoRA adapters.
      </p>
    )
  }

  return (
    <div className="mt-3 space-y-3 rounded border border-zinc-800/80 bg-zinc-950/30 p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        Image generation — {effectiveBase}
      </p>

      <label className="block text-xs text-zinc-400">
        Inference steps
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            type="range"
            min={4}
            max={60}
            value={steps > 0 ? steps : catalogDefault}
            onChange={(e) => setStepsForBase(Number.parseInt(e.target.value, 10))}
            className="min-w-[8rem] flex-1"
          />
          <input
            type="number"
            min={0}
            max={80}
            className="w-16 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-sm"
            value={steps}
            onChange={(e) => setStepsForBase(Number.parseInt(e.target.value, 10) || 0)}
          />
          <button
            type="button"
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setStepsForBase(0)}
            title="Use catalog default for this model"
          >
            Default ({catalogDefault})
          </button>
        </div>
        <span className="mt-0.5 block text-[10px] text-zinc-600">
          {steps === 0
            ? `Using catalog default (${catalogDefault} steps). InterDiffusion Nano is often best around 25.`
            : `Override: ${steps} steps for this model.`}
        </span>
      </label>

      <ImageResolutionControl
        label="Output resolution"
        size={size}
        catalogWidth={modelMeta?.default_width}
        catalogHeight={modelMeta?.default_height}
        onChange={onSizeChange}
      />

      {recommended.length > 0 && (
        <div>
          <p className="text-[10px] text-zinc-500">Suggested adapters</p>
          <ul className="mt-1 space-y-1">
            {recommended.map((rec) => (
              <li key={rec.repo_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-400">
                  {rec.label ?? rec.repo_id}
                  {rec.description ? ` — ${rec.description}` : ''}
                </span>
                <button
                  type="button"
                  className="rounded bg-zinc-700 px-2 py-0.5 text-[10px] hover:bg-zinc-600"
                  onClick={() => addRecommended(rec)}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(modelMeta?.supports_adapters ?? true) && (
        <HfAdapterPanel
          forGguf={false}
          adapters={baseAdapters.map((a) => ({
            repoId: a.adapterRepoId,
            file: a.adapterFile ?? '',
            scale: a.scale
          }))}
          onChange={(rows) =>
            setBaseAdapters(rows.filter((r) => r.repoId && r.file))
          }
          downloadAdapter={async (repoId) => {
            await engineClient.contentStudio.generation.downloadModel(
              'image_adapter',
              repoId,
              repoId.split('/').pop() ?? repoId
            )
          }}
        />
      )}
    </div>
  )
}
