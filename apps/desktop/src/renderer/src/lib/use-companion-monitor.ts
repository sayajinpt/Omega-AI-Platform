import { useCallback, useEffect, useRef, useState } from 'react'
import type { AvatarSignals } from '../../../shared/avatar-signals'
import { engineClient } from './engine'
import {
  ensureCompanionVisibleDefault,
  isCompanionHidden,
  setCompanionHidden as persistCompanionHidden
} from './companion-prefs'
import {
  loadAvatarScale,
  resolveAvatarMonitorAnchor,
  setAvatarMonitorEnabled
} from './avatar-monitor-prefs'
import { getCompanionAnimationStyle } from './companion-animation-style'
import { effectiveAvatarSignalState } from './avatar-stream-viz'

export type CompanionMonitorToggleOptions = {
  hideAfterAttach?: boolean
}

/**
 * Single source of truth for attach/detach + in-window companion visibility.
 * Suppresses duplicate omega:avatar-monitor:enabled events during programmatic toggles.
 */
export function useCompanionMonitor() {
  const [avatarMonitorOn, setAvatarMonitorOn] = useState(false)
  const [companionVisible, setCompanionVisible] = useState(() => {
    ensureCompanionVisibleDefault()
    return !isCompanionHidden()
  })

  const mountedRef = useRef(true)
  const suppressEnabledEventsRef = useRef(0)

  const applyEnabledFromBus = useCallback((enabled: boolean) => {
    if (suppressEnabledEventsRef.current > 0) return
    setAvatarMonitorOn(enabled)
    if (!enabled) {
      const hidden = isCompanionHidden()
      setCompanionVisible(!hidden)
      if (!hidden) persistCompanionHidden(false)
    } else {
      setCompanionVisible(true)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    ensureCompanionVisibleDefault()

    void engineClient.avatarMonitor.getEnabled().then(async (r) => {
      if (!mountedRef.current) return
      const shellHint = r as { overlayWindows?: boolean; embeddedBrowser?: boolean }
      const shellOk = Boolean(shellHint.overlayWindows ?? shellHint.embeddedBrowser)
      if (r.enabled && !shellOk) {
        await setAvatarMonitorEnabled(false)
        if (!mountedRef.current) return
        setAvatarMonitorOn(false)
        persistCompanionHidden(false)
        setCompanionVisible(true)
        return
      }
      const monitorOn = Boolean(r.enabled)
      setAvatarMonitorOn(monitorOn)
      if (monitorOn) {
        const overlayVisible = (r as { overlayVisible?: boolean }).overlayVisible
        setCompanionVisible(overlayVisible !== false)
      } else {
        try {
          localStorage.setItem('omega.avatar.monitor', '0')
        } catch {
          /* ignore */
        }
        const hidden = isCompanionHidden()
        setCompanionVisible(!hidden)
        if (!hidden) persistCompanionHidden(false)
      }
    })

    const offMonitor = engineClient.avatarMonitor.onEnabled(applyEnabledFromBus)
    const onVisibility = (e: Event): void => {
      const hidden = Boolean((e as CustomEvent<{ hidden: boolean }>).detail?.hidden)
      setCompanionVisible(!hidden)
    }
    window.addEventListener('omega:companion-visibility', onVisibility)

    return () => {
      mountedRef.current = false
      offMonitor()
      window.removeEventListener('omega:companion-visibility', onVisibility)
    }
  }, [applyEnabledFromBus])

  const pushOverlaySignals = useCallback(
    (signals: AvatarSignals) => {
      if (!avatarMonitorOn) return
      engineClient.avatarMonitor.pushSignals({
        ...signals,
        state: effectiveAvatarSignalState(signals.state)
      })
    },
    [avatarMonitorOn]
  )

  const toggleMonitor = useCallback(
    async (on: boolean, opts?: CompanionMonitorToggleOptions) => {
      suppressEnabledEventsRef.current += 1
      try {
        if (on) {
          setAvatarMonitorOn(true)
          const anchor = resolveAvatarMonitorAnchor()
          const enabled = await setAvatarMonitorEnabled(true, anchor)
          if (!mountedRef.current) return
          const monitorOn = Boolean(enabled)
          setAvatarMonitorOn(monitorOn)
          if (monitorOn) {
            engineClient.avatarMonitor.syncLayout({
              collapsed: false,
              scale: loadAvatarScale(),
              animationStyle: getCompanionAnimationStyle()
            })
            setCompanionVisible(true)
            persistCompanionHidden(false)
          } else {
            setCompanionVisible(true)
            persistCompanionHidden(false)
          }
          return
        }

        setAvatarMonitorOn(false)
        await setAvatarMonitorEnabled(false)
        if (!mountedRef.current) return
        setAvatarMonitorOn(false)
        if (opts?.hideAfterAttach) {
          setCompanionVisible(false)
          persistCompanionHidden(true)
        } else {
          persistCompanionHidden(false)
          setCompanionVisible(true)
        }
      } finally {
        suppressEnabledEventsRef.current = Math.max(0, suppressEnabledEventsRef.current - 1)
      }
    },
    []
  )

  const onCompanionVisibleChange = useCallback(
    (visible: boolean) => {
      if (avatarMonitorOn && !visible) {
        void toggleMonitor(false, { hideAfterAttach: true })
        return
      }
      setCompanionVisible(visible)
      persistCompanionHidden(!visible)
    },
    [avatarMonitorOn, toggleMonitor]
  )

  const hideInWindowCompanion = useCallback(() => {
    setCompanionVisible(false)
    persistCompanionHidden(true)
  }, [])

  return {
    avatarMonitorOn,
    companionVisible,
    toggleMonitor,
    onCompanionVisibleChange,
    pushOverlaySignals,
    hideInWindowCompanion
  }
}
