import { useEffect, useState } from 'react'
import { FloatingAvatar } from '../components/Avatar3D'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import { engineClient } from '../lib/engine'

const defaultSignals = (): AvatarSignals => ({
  state: 'idle',
  speaking: 0,
  listening: 0
})

/** Detached overlay window — signals and attach state come from runtime event bus. */
export function AvatarMonitorPage() {
  const [signals, setSignals] = useState<AvatarSignals>(defaultSignals)

  useEffect(() => {
    const offSignals = engineClient.avatarMonitor.onSignals((s) => setSignals(s))
    const offEnabled = engineClient.avatarMonitor.onEnabled((enabled) => {
      if (!enabled) window.close()
    })
    return () => {
      offSignals()
      offEnabled()
    }
  }, [])

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-0">
      <FloatingAvatar
        signals={signals}
        overlay
        onMonitorToggle={(on) => {
          if (!on) void engineClient.avatarMonitor.setEnabled(false)
        }}
      />
    </div>
  )
}
