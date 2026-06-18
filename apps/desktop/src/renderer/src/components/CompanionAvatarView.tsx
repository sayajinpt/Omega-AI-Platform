import type { CompanionAnimationStyle } from '../lib/companion-animation-style'
import type { CompanionCustomColors } from '../lib/companion-color-scheme'
import { Avatar3D } from './Avatar3D'
import type { CompanionAvatarVizProps } from './avatar-viz-shared'

export function CompanionAvatarView({
  style,
  customColors,
  ...props
}: CompanionAvatarVizProps & {
  style: CompanionAnimationStyle
  customColors: CompanionCustomColors
}) {
  return <Avatar3D {...props} meshVariant={style} customColors={customColors} />
}
