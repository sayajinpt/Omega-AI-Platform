import { engineClient } from '../lib/engine'
import type { HfAccessHint } from '../lib/hf-gated-types'

export type HfGatedDialogState = {
  repo: string
  message: string
  pageUrl: string
  hint: HfAccessHint
  openedBrowser?: boolean
}

export function HfGatedModelDialog({
  state,
  onClose,
  onRetry,
  onOpenSettings
}: {
  state: HfGatedDialogState | null
  onClose: () => void
  onRetry?: () => void
  onOpenSettings?: () => void
}) {
  if (!state) return null

  const needsToken = state.hint === 'add_token' || state.hint === 'refresh_token'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6">
      <div
        className="w-full max-w-md rounded-xl border border-amber-800/50 bg-zinc-900 p-6 shadow-2xl"
        role="dialog"
        aria-labelledby="hf-gated-title"
      >
        <h2 id="hf-gated-title" className="text-lg font-semibold text-amber-200">
          Hugging Face access required
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{state.message}</p>
        <p className="mt-3 font-mono text-[11px] text-zinc-500">{state.repo}</p>
        {state.openedBrowser ? (
          <p className="mt-2 text-xs text-emerald-400/90">
            The model page should be open in your browser — accept the license there, then continue
            below.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
            onClick={() => void engineClient.models.openHfRepo(state.repo)}
          >
            Open model page
          </button>
          {needsToken ? (
            <button
              type="button"
              className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              onClick={() => onOpenSettings?.()}
            >
              HuggingFace token in Settings
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              className="rounded-lg border border-emerald-700/60 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-950/40"
              onClick={() => {
                onClose()
                onRetry()
              }}
            >
              Retry download
            </button>
          ) : null}
          <button
            type="button"
            className="ml-auto rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
