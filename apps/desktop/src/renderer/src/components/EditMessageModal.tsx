import { useEffect, useRef } from 'react'

export function EditMessageModal({
  initialContent,
  busy,
  onCancel,
  onSubmit
}: {
  initialContent: string
  busy?: boolean
  onCancel: () => void
  onSubmit: (content: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const submit = (): void => {
    const text = textareaRef.current?.value.trim() ?? ''
    if (!text || busy) return
    onSubmit(text)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-message-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="flex w-full max-w-2xl flex-col rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <header className="border-b border-zinc-800 px-5 py-4">
          <h3 id="edit-message-title" className="text-base font-semibold text-indigo-200">
            Edit message
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            Changes replace this message and remove everything after it, then the model replies again.
          </p>
        </header>
        <div className="p-5">
          <textarea
            ref={textareaRef}
            defaultValue={initialContent}
            disabled={busy}
            rows={10}
            className="w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm leading-relaxed text-zinc-100 disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
                return
              }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <p className="mt-2 text-[10px] text-zinc-600">
            Ctrl+Enter save · Esc cancel
          </p>
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Save & resend'}
          </button>
        </footer>
      </div>
    </div>
  )
}
