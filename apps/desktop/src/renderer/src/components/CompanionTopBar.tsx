import type { AvatarSignals } from '../../../shared/avatar-signals'
import { BRAND_NAME } from '../../../shared/brand'
import { setCompanionHidden } from '../lib/companion-prefs'
import { TokenSpeedIndicator } from './TokenSpeedIndicator'
import { GlobalMediaControls } from './GlobalMediaControls'
import { CompanionAnimationStyleMenu } from './CompanionAnimationStyleMenu'
import { CompanionColorSettingsMenu } from './CompanionColorSettingsMenu'

const STATE_LABELS: Record<AvatarSignals['state'], string> = {
  idle: 'Idle',
  thinking: 'Prefill',
  speaking: 'Decode',
  error: 'Error'
}

export function CompanionTopBar({
  avatarEnabled,
  companionVisible,
  detached,
  signals,
  onCompanionVisibleChange,
  onDetachToggle,
  onAnimationStyleChange
}: {
  avatarEnabled: boolean
  companionVisible: boolean
  detached: boolean
  signals: AvatarSignals
  onCompanionVisibleChange: (visible: boolean) => void
  onDetachToggle: (detached: boolean) => void
  onAnimationStyleChange?: (style: import('../lib/companion-animation-style').CompanionAnimationStyle) => void
}) {
  return (
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 bg-zinc-950/95 px-3 py-1.5 text-xs text-zinc-400">
      <span className="shrink-0 font-medium uppercase tracking-wider text-indigo-400/90">{BRAND_NAME}</span>

      <TokenSpeedIndicator compact className="overflow-visible" />

      <GlobalMediaControls />

      {avatarEnabled && (
        <>
          <span className="hidden h-4 w-px bg-zinc-700 sm:block" aria-hidden />
          <span className="font-medium uppercase tracking-wider text-zinc-500">Companion</span>
          <CompanionAnimationStyleMenu
            avatarMonitorOn={detached}
            onStyleChange={onAnimationStyleChange}
          />
          <CompanionColorSettingsMenu />
          <span
            className={`rounded px-1.5 py-0.5 tabular-nums ${
              signals.state === 'error'
                ? 'bg-rose-950/50 text-rose-300'
                : signals.state === 'thinking'
                  ? 'bg-amber-950/40 text-amber-200'
                  : signals.state === 'speaking'
                    ? 'bg-cyan-950/40 text-cyan-200'
                    : 'bg-zinc-800/80 text-zinc-500'
            }`}
          >
            {STATE_LABELS[signals.state]}
          </span>
        </>
      )}

      {avatarEnabled && (
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title={companionVisible ? 'Hide the companion panel' : 'Show the companion panel'}
            onClick={() => {
              const next = !companionVisible
              setCompanionHidden(!next)
              onCompanionVisibleChange(next)
            }}
            className={`rounded-lg border px-2.5 py-0.5 font-medium ${
              companionVisible
                ? 'border-indigo-500/50 bg-indigo-600/25 text-indigo-200'
                : 'border-zinc-600 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {companionVisible ? 'Hide companion' : 'Show companion'}
          </button>
          <button
            type="button"
            title={detached ? 'Attach companion to window' : 'Detach to desktop'}
            onClick={() => void onDetachToggle(!detached)}
            className={`rounded-lg border px-2 py-0.5 ${
              detached
                ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-200'
                : 'border-zinc-700 hover:bg-zinc-800'
            }`}
          >
            {detached ? '⊕ Attach' : '⎋ Detach'}
          </button>
        </div>
      )}
    </header>
  )
}
