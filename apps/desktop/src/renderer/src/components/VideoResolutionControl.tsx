import type { ImageSizeOverride } from '@omega/sdk'
import {
  ImageResolutionControl,
  isDefaultImageSize,
  isVideoAspectSize
} from './ImageResolutionControl'

export const VIDEO_LANDSCAPE_PRESETS = [
  { label: '512 × 288 (16:9)', width: 512, height: 288 },
  { label: '704 × 480 (LTX default)', width: 704, height: 480 },
  { label: '1280 × 720 (720p)', width: 1280, height: 720 }
] as const

export const VIDEO_PORTRAIT_PRESETS = [
  { label: '288 × 512 (9:16)', width: 288, height: 512 },
  { label: '480 × 704 (9:16)', width: 480, height: 704 },
  { label: '720 × 1280 (Shorts)', width: 720, height: 1280 }
] as const

const VIDEO_PRESETS = [...VIDEO_LANDSCAPE_PRESETS, ...VIDEO_PORTRAIT_PRESETS]

export function VideoResolutionControl({
  label,
  size,
  catalogWidth,
  catalogHeight,
  onChange
}: {
  label: string
  size: ImageSizeOverride | undefined
  catalogWidth?: number
  catalogHeight?: number
  onChange: (size: ImageSizeOverride | undefined) => void
}) {
  return (
    <ImageResolutionControl
      label={label}
      size={size}
      catalogWidth={catalogWidth}
      catalogHeight={catalogHeight}
      showVideoAspect={false}
      presets={VIDEO_PRESETS}
      hint="Higher resolutions use more VRAM and take longer. LTX is tuned for ~704×480."
      onChange={onChange}
    />
  )
}

export { isDefaultImageSize as isDefaultVideoSize, isVideoAspectSize }
