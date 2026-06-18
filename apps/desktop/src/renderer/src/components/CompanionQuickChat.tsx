import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MediaRef } from '@omega/sdk'
import { onChatAttachment } from '../lib/chat-attach-bridge'
import { onCompanionReply } from '../lib/companion-reply-bridge'
import { resolveCompanionModel, sendCompanionMessage } from '../lib/companion-chat'
import { speechRecognitionAvailable, startListening } from '../lib/voice-assistant'

function useAutoResizeTextarea(
  value: string,
  fontPx: number,
  maxRows: number
): React.RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    const lineHeight = fontPx * 1.45
    const maxHeight = Math.ceil(lineHeight * maxRows + 8)
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value, fontPx, maxRows])

  return ref
}

export function CompanionQuickChat({
  uiScale,
  onClose
}: {
  uiScale: number
  onClose: () => void
}) {
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [pendingAttach, setPendingAttach] = useState<MediaRef[]>([])
  const [modelReady, setModelReady] = useState(true)
  const [userLine, setUserLine] = useState('')
  const [assistantLine, setAssistantLine] = useState('')
  const [replyDone, setReplyDone] = useState(true)
  const stopListenRef = useRef<(() => void) | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const fontPx = Math.max(9, Math.round(10 * uiScale))
  const inputMaxRows = 4
  const replyMaxRows = Math.max(3, Math.round(5 * uiScale))
  const inputRef = useAutoResizeTextarea(input, fontPx, inputMaxRows)

  const refreshModel = useCallback(() => {
    void resolveCompanionModel().then(({ modelId }) => {
      const ready = Boolean(modelId)
      setModelReady(ready)
      setError(ready ? null : 'No model available — add one in Model Studio or Settings.')
    })
  }, [])

  useEffect(() => {
    refreshModel()
    const onStart = (): void => setStreaming(true)
    const onEnd = (): void => setStreaming(false)
    window.addEventListener('omega:streaming-start', onStart)
    window.addEventListener('omega:streaming-end', onEnd)
    return () => {
      window.removeEventListener('omega:streaming-start', onStart)
      window.removeEventListener('omega:streaming-end', onEnd)
      stopListenRef.current?.()
    }
  }, [refreshModel])

  useEffect(() => {
    return onCompanionReply((payload) => {
      if (payload.userText != null) setUserLine(payload.userText)
      setAssistantLine(payload.assistantText)
      setReplyDone(payload.done)
      if (payload.error) setError(payload.error)
      else if (payload.done && payload.assistantText.trim()) setError(null)
    })
  }, [])

  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [userLine, assistantLine, streaming])

  const sendWith = useCallback(
    (text: string, attachments: MediaRef[] = []) => {
      const trimmed = text.trim()
      if (!trimmed && !attachments.length) return
      if (streaming) {
        setError('Wait for the current reply to finish.')
        return
      }
      setInput('')
      setPendingAttach([])
      setError(null)
      setUserLine(trimmed)
      setAssistantLine('')
      setReplyDone(false)
      void (async () => {
        try {
          const { modelId } = await resolveCompanionModel()
          if (!modelId) {
            setError('No model available — add one in Model Studio or Settings.')
            setModelReady(false)
            setReplyDone(true)
            return
          }
          setModelReady(true)
          const res = await sendCompanionMessage({ userText: trimmed, attachments })
          if (!res.ok) {
            setError(res.error ?? 'Could not send to chat')
            setReplyDone(true)
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setReplyDone(true)
        }
      })()
    },
    [streaming]
  )

  useEffect(() => {
    return onChatAttachment((detail) => {
      if (detail.target !== 'main' && detail.target !== 'companion') return
      setPendingAttach([detail.mediaRef])
      if (detail.autoSend) {
        const prompt = detail.prompt ?? 'What do you see in this screenshot?'
        sendWith(prompt, [detail.mediaRef])
      }
    })
  }, [sendWith])

  const toggleVoice = (): void => {
    if (!speechRecognitionAvailable()) return
    if (listening) {
      stopListenRef.current?.()
      stopListenRef.current = null
      setListening(false)
      return
    }
    setListening(true)
    stopListenRef.current = startListening((text, final) => {
      if (text) setInput(text)
      if (final) {
        stopListenRef.current?.()
        stopListenRef.current = null
        setListening(false)
      }
    })
  }

  const showTranscript = Boolean(userLine || assistantLine || (streaming && !replyDone))

  return (
    <div
      className="flex max-h-[min(42vh,11rem)] flex-col gap-1 rounded-lg border border-indigo-500/50 bg-zinc-950/92 p-1.5 shadow-lg backdrop-blur-md"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {error && (
        <p className="shrink-0 rounded border border-rose-500/40 bg-rose-950/40 px-1.5 py-0.5 text-[10px] font-medium text-rose-200">
          {error}
        </p>
      )}
      {showTranscript && (
        <div
          ref={transcriptRef}
          className="min-h-0 shrink overflow-y-auto rounded border border-zinc-800/80 bg-zinc-900/60 px-1.5 py-1"
          style={{ maxHeight: Math.round(fontPx * 1.45 * replyMaxRows + 12) }}
        >
          {userLine && (
            <p className="mb-1 text-[9px] leading-snug text-indigo-300/95" style={{ fontSize: fontPx }}>
              <span className="font-medium text-indigo-400/80">You · </span>
              <span className="text-indigo-100/90">{userLine}</span>
            </p>
          )}
          {(assistantLine || (streaming && !replyDone)) && (
            <p
              className="whitespace-pre-wrap text-[9px] leading-snug text-zinc-200"
              style={{ fontSize: fontPx }}
            >
              <span className="font-medium text-cyan-400/80">Ω · </span>
              {assistantLine || (streaming ? '…' : '')}
              {streaming && !replyDone && (
                <span className="ml-0.5 inline-block h-2 w-0.5 animate-pulse bg-cyan-400/80" />
              )}
            </p>
          )}
        </div>
      )}
      {pendingAttach.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1">
          {pendingAttach.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800/80 px-1 py-0.5 text-[9px] text-zinc-300"
            >
              🖼 {a.name ?? 'shot'}
              <button type="button" className="text-zinc-500 hover:text-rose-300" onClick={() => setPendingAttach([])}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-end gap-1">
        {speechRecognitionAvailable() && (
          <button
            type="button"
            title={listening ? 'Stop' : 'Voice input'}
            disabled={streaming}
            onClick={toggleVoice}
            className={`shrink-0 rounded border px-1.5 py-0.5 text-xs disabled:opacity-40 ${
              listening
                ? 'border-rose-600 bg-rose-950/50 text-rose-300'
                : 'border-zinc-600 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {listening ? '■' : '🎤'}
          </button>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendWith(input, pendingAttach)
            }
            if (e.key === 'Escape') onClose()
          }}
          disabled={streaming}
          placeholder={listening ? 'Listening…' : streaming ? 'Reply streaming…' : 'Message current chat…'}
          className="min-h-[1.4em] min-w-0 flex-1 resize-none rounded border border-zinc-600 bg-zinc-900/90 px-2 py-0.5 leading-snug text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500/60 focus:outline-none"
          style={{ fontSize: fontPx }}
        />
        <button
          type="button"
          disabled={streaming || (!input.trim() && !pendingAttach.length)}
          onClick={() => sendWith(input, pendingAttach)}
          className="shrink-0 rounded bg-indigo-600 px-2 py-0.5 text-xs text-white disabled:opacity-40"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="Close"
        >
          ×
        </button>
      </div>
    </div>
  )
}
