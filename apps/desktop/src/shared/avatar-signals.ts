export interface AvatarSignals {
  speaking: number
  listening: number
  state: 'idle' | 'thinking' | 'speaking' | 'error'
}
