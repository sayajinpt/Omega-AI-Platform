import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { MediaRef } from '@omega/sdk'
import { onChatAttachment } from '../lib/chat-attach-bridge'
import { speechRecognitionAvailable, startListening } from '../lib/voice-assistant'
import { engineClient } from '../lib/engine'

export type ChatComposerHandle = { focus: () => void; blur: () => void }

const ATTACH_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,image/bmp,.pdf,.txt,.md,.csv,.json,.wav,.mp3,.m4a,.ogg,.webm,.mp4'

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export const ChatComposer = forwardRef(function ChatComposer(
  {
    value,
    onChange,
    onSend,
    disabled,
    modelId,
    sessionId,
    streaming,
    onEnsureSession,
    voiceEnabled
  }: {
    value: string
    onChange: (v: string) => void
    onSend: (attachments: MediaRef[], textOverride?: string) => void
    disabled?: boolean
    /** When empty, user can still type; Send stays disabled until a model is chosen. */
    modelId?: string
    sessionId: string | null
    streaming?: boolean
    onEnsureSession?: () => Promise<string | null>
    voiceEnabled?: boolean
  },
  ref: React.Ref<ChatComposerHandle>
) {
  const [pending, setPending] = useState<MediaRef[]>([])
  const [limits, setLimits] = useState({ maxBytes: 25 * 1024 * 1024, maxCount: 8 })
  const [listening, setListening] = useState(false)
  const stopListenRef = useRef<(() => void) | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = inputRef.current
      if (!el) return
      el.focus({ preventScroll: true })
    },
    blur: () => inputRef.current?.blur()
  }))

  useEffect(() => {
    void engineClient.chat.attachmentLimits().then(setLimits)
  }, [])

  useEffect(() => {
    return onChatAttachment((detail) => {
      if (detail.target !== 'main') return
      setPending((prev) => {
        if (prev.some((a) => a.id === detail.mediaRef.id)) return prev
        if (prev.length >= limits.maxCount) return prev
        return [...prev, detail.mediaRef]
      })
      if (detail.autoSend) {
        const prompt = detail.prompt ?? 'What do you see in this screenshot?'
        onChange(prompt)
        onSend([detail.mediaRef], prompt)
        setPending([])
      }
    })
  }, [limits.maxCount, onChange, onSend])

  const stageLocalFiles = useCallback(
    async (files: FileList | File[]) => {
      if (disabled) return
      let sid = sessionId
      if (!sid && onEnsureSession) sid = await onEnsureSession()
      if (!sid) return
      const next: MediaRef[] = [...pending]
      for (const file of Array.from(files)) {
        if (next.length >= limits.maxCount) break
        try {
          const data = await fileToBase64(file)
          const ref = await engineClient.chat.stageAttachmentData(
            sid,
            file.name,
            data,
            file.type || undefined
          )
          next.push(ref)
        } catch (e) {
          console.error(e)
        }
      }
      if (next.length > pending.length) setPending(next)
    },
    [sessionId, disabled, pending, limits.maxCount, onEnsureSession]
  )

  const attachFiles = useCallback(async () => {
    if (disabled) return
    let sid = sessionId
    if (!sid && onEnsureSession) sid = await onEnsureSession()
    if (!sid) return
    try {
      const paths = await engineClient.chat.pickAttachments()
      if (paths.length > 0) {
        const next: MediaRef[] = [...pending]
        for (const p of paths) {
          if (next.length >= limits.maxCount) break
          const ref = await engineClient.chat.stageAttachment(sid, p)
          next.push(ref)
        }
        setPending(next)
        return
      }
      fileInputRef.current?.click()
    } catch (e) {
      console.error(e)
      fileInputRef.current?.click()
    }
  }, [sessionId, disabled, pending, limits.maxCount, onEnsureSession])

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((a) => a.id !== id))
  }

  const canSend = Boolean((value.trim() || pending.length) && !disabled && modelId?.trim())
  const inputLocked = Boolean(disabled)

  return (
    <footer
      className="relative z-30 border-t border-zinc-800 bg-zinc-950 p-3"
      onDragOver={(e) => {
        if (disabled || streaming) return
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        if (disabled || streaming) return
        if (!e.dataTransfer.files?.length) return
        e.preventDefault()
        void stageLocalFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ATTACH_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files
          if (files?.length) void stageLocalFiles(files)
          e.target.value = ''
        }}
      />
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-xs text-zinc-300"
            >
              {a.kind === 'image' ? '🖼' : '📎'} {a.name ?? a.id}
              <button
                type="button"
                className="text-zinc-500 hover:text-rose-300"
                onClick={() => removePending(a.id)}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          title="Attach file"
          disabled={disabled || streaming}
          onClick={() => void attachFiles()}
          className="rounded-xl border border-zinc-700 px-3 text-sm text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
        >
          +
        </button>
        {voiceEnabled && speechRecognitionAvailable() && (
          <button
            type="button"
            title={listening ? 'Stop listening' : 'Voice input'}
            disabled={disabled || streaming}
            onClick={() => {
              if (listening) {
                stopListenRef.current?.()
                stopListenRef.current = null
                setListening(false)
                return
              }
              setListening(true)
              stopListenRef.current = startListening((text, final) => {
                if (text) onChange(text)
                if (final) {
                  stopListenRef.current?.()
                  stopListenRef.current = null
                  setListening(false)
                }
              })
            }}
            className={`rounded-xl border px-3 text-sm disabled:opacity-40 ${
              listening
                ? 'border-rose-600 bg-rose-950/50 text-rose-300'
                : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {listening ? '■' : '🎤'}
          </button>
        )}
        <textarea
          ref={inputRef}
          data-omega-chat-composer=""
          value={value}
          readOnly={inputLocked}
          onChange={(e) => {
            if (inputLocked) return
            onChange(e.target.value)
          }}
          onMouseDown={(e) => {
            e.stopPropagation()
            e.currentTarget.focus({ preventScroll: true })
          }}
          onClick={(e) => {
            e.stopPropagation()
            e.currentTarget.focus({ preventScroll: true })
          }}
          onKeyDown={(e) => {
            if (inputLocked) return
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault()
              if (canSend) {
                onSend(pending)
                setPending([])
              }
            }
          }}
          rows={2}
          placeholder={
            modelId?.trim()
              ? 'Message… Enter send · attach with +'
              : 'Select a model above, then type your message…'
          }
          className={`pointer-events-auto relative z-10 flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 ${
            inputLocked ? 'cursor-not-allowed opacity-60' : ''
          }`}
          aria-disabled={inputLocked}
        />
        <button
          type="button"
          onClick={() => {
            if (!canSend) return
            onSend(pending)
            setPending([])
          }}
          disabled={!canSend}
          className="rounded-xl bg-indigo-600 px-4 text-sm disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </footer>
  )
})
