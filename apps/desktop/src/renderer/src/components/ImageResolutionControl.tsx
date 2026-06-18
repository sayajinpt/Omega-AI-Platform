import type { ImageSizeOverride } from '@omega/sdk'

export type ResolutionPreset = { label: string; width: number; height: number }

const SQUARE_PRESETS: ResolutionPreset[] = [
  { label: '512 × 512', width: 512, height: 512 },
  { label: '768 × 768', width: 768, height: 768 },
  { label: '1024 × 1024', width: 1024, height: 1024 },
  { label: '1280 × 1280', width: 1280, height: 1280 }
]

/** Sentinel stored in settings: use video brief aspect (16:9 / 9:16). */
export const IMAGE_SIZE_VIDEO_ASPECT: ImageSizeOverride = { width: -1, height: -1 }

export function isVideoAspectSize(size: ImageSizeOverride | undefined): boolean {
  return size?.width === -1 && size?.height === -1
}

export function isDefaultImageSize(size: ImageSizeOverride | undefined): boolean {
  if (!size) return true
  return size.width === 0 && size.height === 0
}

function describeSize(
  size: ImageSizeOverride | undefined,
  catalogW?: number,
  catalogH?: number
): string {
  if (isVideoAspectSize(size)) return 'Video / brief aspect (1280×720 or 720×1280)'
  if (!isDefaultImageSize(size) && size) return `${size.width} × ${size.height}`
  if (catalogW && catalogH) return `Catalog default (${catalogW} × ${catalogH})`
  return 'Catalog / brief default'
}

export function ImageResolutionControl({
  label,
  size,
  catalogWidth,
  catalogHeight,
  showVideoAspect = true,
  presets = SQUARE_PRESETS,
  hint,
  onChange
}: {
  label: string
  size: ImageSizeOverride | undefined
  catalogWidth?: number
  catalogHeight?: number
  /** Content Studio only — match video brief 16:9 / 9:16. */
  showVideoAspect?: boolean
  presets?: readonly ResolutionPreset[]
  hint?: string
  onChange: (size: ImageSizeOverride | undefined) => void
}) {
  const custom = !isDefaultImageSize(size) && !isVideoAspectSize(size) ? size : undefined
  const presetValue = isVideoAspectSize(size)
    ? 'aspect'
    : custom
      ? `${custom.width}x${custom.height}`
      : 'default'

  return (
    <label className="block text-xs text-zinc-400">
      {label}
      <select
        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        value={presetValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'default') {
            onChange(undefined)
            return
          }
          if (v === 'aspect') {
            onChange(IMAGE_SIZE_VIDEO_ASPECT)
            return
          }
          const preset = presets.find((p) => `${p.width}x${p.height}` === v)
          if (preset) {
            onChange({ width: preset.width, height: preset.height })
          }
        }}
      >
        <option value="default">{describeSize(undefined, catalogWidth, catalogHeight)}</option>
        {showVideoAspect && <option value="aspect">Video / brief aspect</option>}
        {presets.map((p) => (
          <option key={p.label} value={`${p.width}x${p.height}`}>
            {p.label}
          </option>
        ))}
        {custom &&
          !presets.some((p) => p.width === custom.width && p.height === custom.height) && (
            <option value={`${custom.width}x${custom.height}`}>
              Custom {custom.width} × {custom.height}
            </option>
          )}
      </select>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <input
          type="number"
          min={64}
          max={2048}
          step={8}
          placeholder="Width"
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          value={custom?.width ?? ''}
          onChange={(e) => {
            const w = Number.parseInt(e.target.value, 10) || 0
            const h = custom?.height ?? catalogHeight ?? 1024
            if (w > 0) onChange({ width: w, height: h })
          }}
        />
        <input
          type="number"
          min={64}
          max={2048}
          step={8}
          placeholder="Height"
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          value={custom?.height ?? ''}
          onChange={(e) => {
            const h = Number.parseInt(e.target.value, 10) || 0
            const w = custom?.width ?? catalogWidth ?? 1024
            if (h > 0) onChange({ width: w, height: h })
          }}
        />
      </div>
      <span className="mt-1 block text-[10px] text-zinc-600">
        Active: {describeSize(size, catalogWidth, catalogHeight)}.
        {hint ?? ' SDXL models are fastest near 1024².'}
      </span>
    </label>
  )
}
