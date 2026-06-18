import { useEffect, useState } from 'react'
import type { MessagePart } from '@omega/sdk'

type ChoicesPart = Extract<MessagePart, { type: 'choices' }>

export function AssistantChoicesCard({
  part,
  disabled,
  onSend,
  onDismiss,
  onFillComposer
}: {
  part: ChoicesPart
  disabled?: boolean
  onSend: (value: string) => void
  onDismiss: () => void
  onFillComposer?: (value: string) => void
}) {
  const pending = (part.status ?? 'pending') === 'pending'
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [custom, setCustom] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  useEffect(() => {
    if (!pending) return
    setSelected(new Set())
    setCustom('')
    setEditingId(null)
  }, [part.options, pending])

  if (!pending && part.status === 'dismissed') {
    return (
      <p className="text-[11px] italic text-zinc-500">Suggestions dismissed — reply in your own words below.</p>
    )
  }

  if (!pending && part.selectedValue) {
    return (
      <p className="text-[11px] text-zinc-400">
        <span className="text-emerald-400/90">Selected:</span> {part.selectedValue}
      </p>
    )
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (part.multiSelect) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      } else {
        next.clear()
        next.add(id)
      }
      return next
    })
  }

  const sendPicked = () => {
    if (part.multiSelect && selected.size > 0) {
      const values = part.options.filter((o) => selected.has(o.id)).map((o) => o.value)
      onSend(values.join('; '))
      return
    }
    const one = part.options.find((o) => selected.has(o.id))
    if (one) onSend(one.value)
  }

  const startEdit = (opt: ChoicesPart['options'][0]) => {
    setEditingId(opt.id)
    setEditText(opt.value)
  }

  const sendEdited = () => {
    const t = editText.trim()
    if (t) onSend(t)
  }

  return (
    <div className="mt-2 rounded-lg border border-indigo-500/35 bg-indigo-950/30 p-2.5">
      {part.prompt ? (
        <p className="mb-2 text-xs font-medium text-indigo-100/95">{part.prompt}</p>
      ) : (
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-indigo-300/80">
          Pick an option
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {part.options.map((opt) => {
          const active = selected.has(opt.id)
          const editing = editingId === opt.id
          return (
            <div key={opt.id} className="flex max-w-full flex-col gap-1">
              {editing ? (
                <div className="flex min-w-[12rem] flex-col gap-1 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
                    disabled={disabled}
                    autoFocus
                  />
                  <button
                    type="button"
                    disabled={disabled || !editText.trim()}
                    onClick={sendEdited}
                    className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    disabled={disabled}
                    title={opt.description ?? opt.value}
                    onClick={() => {
                      if (part.multiSelect) toggle(opt.id)
                      else onSend(opt.value)
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-left text-xs transition ${
                      active
                        ? 'border-indigo-400 bg-indigo-600/40 text-indigo-50'
                        : 'border-zinc-600 bg-zinc-900/80 text-zinc-200 hover:border-indigo-500/60 hover:bg-zinc-800'
                    }`}
                  >
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && (
                      <span className="mt-0.5 block text-[10px] font-normal text-zinc-500">
                        {opt.description}
                      </span>
                    )}
                  </button>
                  {!part.multiSelect && onFillComposer && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onFillComposer(opt.value)}
                      className="rounded px-1 text-[10px] text-zinc-500 hover:text-indigo-300"
                      title="Put in message box to edit before sending"
                    >
                      Edit
                    </button>
                  )}
                  {!part.multiSelect && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => startEdit(opt)}
                      className="rounded px-1 text-[10px] text-zinc-500 hover:text-indigo-300"
                      title="Edit this answer, then send"
                    >
                      Tweak
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {part.multiSelect && selected.size > 0 && (
        <button
          type="button"
          disabled={disabled}
          onClick={sendPicked}
          className="mt-2 rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
        >
          Send selection ({selected.size})
        </button>
      )}

      {part.allowCustom && (
        <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-start">
          {part.inputKind === 'textarea' ? (
            <textarea
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Type or paste the full script…"
              disabled={disabled}
              rows={4}
              className="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
            />
          ) : (
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Or type your own answer…"
              disabled={disabled}
              className="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom.trim()) {
                  e.preventDefault()
                  onSend(custom.trim())
                }
              }}
            />
          )}
          <button
            type="button"
            disabled={disabled || !custom.trim()}
            onClick={() => onSend(custom.trim())}
            className="rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-300 hover:border-indigo-500/50 hover:bg-zinc-800 sm:mt-0"
          >
            Send custom
          </button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onDismiss}
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
        >
          None of these — I&apos;ll type my own reply
        </button>
      </div>
    </div>
  )
}
