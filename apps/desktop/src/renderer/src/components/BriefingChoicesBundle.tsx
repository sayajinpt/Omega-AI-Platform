import { useCallback, useMemo, useState } from 'react'
import type { Message, MessagePart } from '@omega/sdk'

type ChoicesPart = Extract<MessagePart, { type: 'choices' }>

const OMEGA_DEFAULTS_RE =
  /\b(use\s+defaults|you\s+(?:decide|choose)|omega\s+(?:can\s+)?choose|let\s+omega)\b/i

export const OMEGA_BRIEFING_DEFAULTS_VALUE =
  'Use defaults for all unspecified settings — you decide tone, voice, visuals, and subtitles.'

export function BriefingChoicesBundle({
  message,
  disabled,
  onSubmit,
  onDismissAll,
  onFillComposer
}: {
  message: Message
  disabled?: boolean
  /** Sends one combined user message with all picked answers. */
  onSubmit: (
    combinedValue: string,
    picks: Array<{ partIndex: number; value: string }>,
    opts?: { omegaChoosesRest?: boolean }
  ) => void
  onDismissAll: () => void
  onFillComposer?: (value: string) => void
}) {
  const parts = message.parts ?? []
  const choiceEntries = useMemo(
    () =>
      parts
        .map((p, partIndex) => (p.type === 'choices' ? { partIndex, part: p as ChoicesPart } : null))
        .filter((x): x is { partIndex: number; part: ChoicesPart } => x !== null),
    [parts]
  )

  const pendingEntries = choiceEntries.filter((e) => (e.part.status ?? 'pending') === 'pending')

  const [draft, setDraft] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {}
    for (const { partIndex, part } of choiceEntries) {
      if (part.selectedValue) init[partIndex] = part.selectedValue
    }
    return init
  })

  const pick = useCallback((partIndex: number, value: string) => {
    setDraft((prev) => ({ ...prev, [partIndex]: value }))
  }, [])

  const letOmegaChooseRest = useMemo(
    () =>
      choiceEntries.some((e) => {
        const v = draft[e.partIndex]?.trim()
        return Boolean(v && OMEGA_DEFAULTS_RE.test(v))
      }),
    [choiceEntries, draft]
  )

  const explicitAnsweredCount = pendingEntries.filter((e) => {
    const v = draft[e.partIndex]?.trim()
    return Boolean(v && !OMEGA_DEFAULTS_RE.test(v))
  }).length

  const allAnswered =
    pendingEntries.length > 0 && pendingEntries.every((e) => Boolean(draft[e.partIndex]?.trim()))

  const canSubmit = pendingEntries.length > 0 && (allAnswered || letOmegaChooseRest)

  const submitAll = () => {
    const lines: string[] = []
    const picks: Array<{ partIndex: number; value: string }> = []
    let omegaLineAdded = false

    for (const e of pendingEntries) {
      const v = draft[e.partIndex]?.trim() ?? ''
      if (!v) continue
      if (OMEGA_DEFAULTS_RE.test(v)) {
        if (!omegaLineAdded) {
          lines.push(OMEGA_BRIEFING_DEFAULTS_VALUE)
          omegaLineAdded = true
        }
        picks.push({ partIndex: e.partIndex, value: v })
        continue
      }
      lines.push(v)
      picks.push({ partIndex: e.partIndex, value: v })
    }

    if (letOmegaChooseRest && !omegaLineAdded) {
      lines.push(OMEGA_BRIEFING_DEFAULTS_VALUE)
      const quick =
        pendingEntries.find((e) => e.part.prompt === 'Quick setup') ?? pendingEntries[0]
      if (quick) {
        picks.push({ partIndex: quick.partIndex, value: OMEGA_BRIEFING_DEFAULTS_VALUE })
      }
    }

    if (!lines.length) return
    onSubmit(lines.join('\n'), picks, { omegaChoosesRest: letOmegaChooseRest })
  }

  if (pendingEntries.length === 0) {
    return (
      <p className="text-[11px] text-zinc-500 italic">
        Briefing choices completed — continue in the message box if needed.
      </p>
    )
  }

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-indigo-500/35 bg-indigo-950/25 p-2.5">
      {choiceEntries.map(({ partIndex, part }) => {
        const pending = (part.status ?? 'pending') === 'pending'
        const picked = draft[partIndex]
        if (!pending && part.status === 'dismissed') return null
        if (!pending && part.selectedValue) {
          return (
            <div key={partIndex} className="rounded-md border border-zinc-700/80 bg-zinc-900/50 px-2 py-1.5">
              {part.prompt && <p className="text-[11px] text-zinc-500">{part.prompt}</p>}
              <p className="text-xs text-emerald-300/90">{part.selectedValue}</p>
            </div>
          )
        }
        return (
          <div key={partIndex} className="rounded-md border border-zinc-700/60 bg-zinc-950/60 p-2">
            {part.prompt && (
              <p className="mb-1.5 text-xs font-medium text-indigo-100/95">{part.prompt}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {part.options.map((opt) => {
                const active = picked === opt.value
                return (
                  <div key={opt.id} className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      disabled={disabled}
                      title={opt.description ?? opt.value}
                      onClick={() => pick(partIndex, opt.value)}
                      className={`rounded-lg border px-2.5 py-1 text-left text-xs transition ${
                        active
                          ? 'border-indigo-400 bg-indigo-600/40 text-indigo-50'
                          : 'border-zinc-600 bg-zinc-900/80 text-zinc-200 hover:border-indigo-500/60 hover:bg-zinc-800'
                      }`}
                    >
                      <span className="font-medium">{opt.label}</span>
                    </button>
                    {onFillComposer && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onFillComposer(opt.value)}
                        className="rounded px-1 text-[10px] text-zinc-500 hover:text-indigo-300"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {part.allowCustom && (
              <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={picked && !part.options.some((o) => o.value === picked) ? picked : ''}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [partIndex]: e.target.value }))
                  }
                  placeholder="Or type your own…"
                  disabled={disabled}
                  className="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
                />
              </div>
            )}
          </div>
        )
      })}

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-700/60 pt-2">
        <button
          type="button"
          disabled={disabled || !canSubmit}
          onClick={submitAll}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {letOmegaChooseRest
            ? `Submit answers (${explicitAnsweredCount} picked, Omega chooses rest)`
            : `Submit answers (${explicitAnsweredCount}/${pendingEntries.length})`}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onDismissAll}
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
        >
          Skip — I&apos;ll type my own reply
        </button>
      </div>
    </div>
  )
}
