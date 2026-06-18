import type { ContentGenerationModelEntry, ImageSizeOverride } from '@omega/sdk'
import { VideoResolutionControl } from './VideoResolutionControl'

export function ContentStudioVideoOptions({
  baseRepoId,
  modelMeta,
  steps,
  size,
  onStepsChange,
  onSizeChange
}: {
  /** Active video model (pinned repo or catalog default). */
  baseRepoId: string
  modelMeta?: ContentGenerationModelEntry
  steps: number
  size?: ImageSizeOverride
  onStepsChange: (steps: number) => void
  onSizeChange: (size: ImageSizeOverride | undefined) => void
}) {
  const catalogDefault = modelMeta?.default_num_steps ?? 30
  const effectiveBase = baseRepoId.trim() || modelMeta?.repo_id || ''

  const setStepsForBase = (value: number) => {
    onStepsChange(Math.max(0, Math.min(80, value)))
  }

  if (!effectiveBase) {
    return (
      <p className="mt-2 text-[10px] text-zinc-600">
        Select or download a text-to-video model under Model roles to configure inference steps.
      </p>
    )
  }

  return (
    <div className="mt-3 space-y-3 rounded border border-zinc-800/80 bg-zinc-950/30 p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        Text-to-video — {effectiveBase}
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
            ? `Using catalog default (${catalogDefault} steps). Higher steps improve quality but take longer.`
            : `Override: ${steps} steps for this model.`}
        </span>
      </label>

      <VideoResolutionControl
        label="Output resolution"
        size={size}
        catalogWidth={modelMeta?.default_width ?? 704}
        catalogHeight={modelMeta?.default_height ?? 480}
        onChange={onSizeChange}
      />
    </div>
  )
}
