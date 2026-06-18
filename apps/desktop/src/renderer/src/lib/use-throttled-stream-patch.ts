import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import type { Message } from '@omega/sdk'
import { buildAssistantMessageParts, shouldStreamAgentMarkup } from '../../../shared/assistant-choices'
import { mergeAssistantPatchParts } from '../../../shared/message-parts'

const STREAM_UI_MS = 32

/**
 * Batches streaming token updates so React re-renders at most ~30/s during inference.
 * First visible token flushes immediately (ChatGPT-style bubble growth).
 */
export function useThrottledStreamPatch(
  setMessages: Dispatch<SetStateAction<Message[]>>,
  opts?: { onFlush?: () => void }
) {
  const assistantTextRef = useRef('')
  const assistantMediaRef = useRef<NonNullable<Message['parts']>>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef(false)
  const hasVisibleFlushRef = useRef(false)

  const flush = useCallback(() => {
    pendingRef.current = false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const built = buildAssistantMessageParts(assistantTextRef.current, assistantMediaRef.current)
    setMessages((prev) => {
      if (!prev.length) return prev
      const last = prev[prev.length - 1]
      if (last?.role !== 'assistant') return prev
      const preserved = (last.parts ?? []).filter((p) => p.type !== 'text')
      const mergedParts = mergeAssistantPatchParts(preserved, built.parts ?? [])
      const copy = [...prev]
      copy[copy.length - 1] = {
        role: 'assistant',
        content: built.content,
        parts: mergedParts.length ? mergedParts : built.parts,
        reasoningContent: built.reasoningContent,
        reasoningOpen: built.reasoningOpen
      }
      return copy
    })
    if (built.content.trim() || built.parts?.length) hasVisibleFlushRef.current = true
    opts?.onFlush?.()
  }, [setMessages, opts?.onFlush])

  const scheduleFlush = useCallback(() => {
    if (pendingRef.current) return
    pendingRef.current = true
    timerRef.current = setTimeout(flush, STREAM_UI_MS)
  }, [flush])

  const resetStreamBuffers = useCallback(() => {
    assistantTextRef.current = ''
    assistantMediaRef.current = []
    pendingRef.current = false
    hasVisibleFlushRef.current = false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const appendToken = useCallback(
    (text: string) => {
      assistantTextRef.current += text
      if (!shouldStreamAgentMarkup(assistantTextRef.current)) return
      if (!hasVisibleFlushRef.current) {
        flush()
        return
      }
      scheduleFlush()
    },
    [flush, scheduleFlush]
  )

  const pushMediaPart = useCallback(
    (
      part: NonNullable<Message['parts']>[number],
      merge: (
        parts: Message['parts'],
        incoming: NonNullable<Message['parts']>[number]
      ) => Message['parts']
    ) => {
      const merged = merge(assistantMediaRef.current, part)
      assistantMediaRef.current = merged ?? []
      scheduleFlush()
    },
    [scheduleFlush]
  )

  return {
    appendToken,
    pushMediaPart,
    flush,
    resetStreamBuffers,
    getAssistantText: () => assistantTextRef.current
  }
}
