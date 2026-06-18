export interface AvatarMonitorState {
  x: number
  y: number
  collapsed: boolean
  scale?: number
}

import type { CompanionAnimationStyle } from './companion-animation-style'

export interface AvatarMonitorLayout {
  collapsed: boolean
  scale?: number
  /** Screen coordinates (desktop monitor window position). */
  x?: number
  y?: number
  /** Companion viz style (detached window sync). */
  animationStyle?: CompanionAnimationStyle
}
