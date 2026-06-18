import { useMemo } from 'react'
import type { Message, MessagePart } from '@omega/sdk'
import { sessionMediaUrl } from '@omega/sdk'
import { parseMarkdownCodeSegments } from '../lib/parse-markdown-segments'
import { stripToolArtifacts } from '../../../shared/assistant-choices'
import { resolveMessageThinking, shouldShowThinkingPanel } from '../../../shared/split-message-thinking'
import { ChatCodeBlock } from './ChatCodeBlock'
import { OmegaChatMarkdown } from './OmegaChatMarkdown'
import { ThinkingPanel } from './ThinkingPanel'
import { engineClient } from '../lib/engine'

function ReviewInPanelButton({ sessionId, part }: { sessionId: string; part: MessagePart }) {
  if (part.type !== 'image' && part.type !== 'video' && part.type !== 'audio' && part.type !== 'file') {
    return null
  }
  return (
    <button
      type="button"
      className="text-[10px] text-indigo-300 hover:underline"
      onClick={() => void engineClient.media.showPreview(sessionId, part)}
    >
      Open in review panel
    </button>
  )
}
import { ContentStudioMessageCard } from './ContentStudioMessageCard'
import { DirectVideoMessageCard } from './DirectVideoMessageCard'
import { YouTubeMessageCard } from './YouTubeMessageCard'
import { AssistantChoicesCard } from './AssistantChoicesCard'
import { BriefingChoicesBundle } from './BriefingChoicesBundle'

export function MessageContent({
  message,
  sessionId,
  streaming,
  onOpenContentStudio,
  onOpenBrowser,
  onChoiceSend,
  onChoiceDismiss,
  onChoiceFillComposer,
  onChoiceBundleSubmit,
  onChoiceBundleDismiss,
  choicesDisabled,
  editableCode,
  onCodeBlockEdit
}: {
  message: Message
  sessionId: string | null
  streaming?: boolean
  onOpenContentStudio?: () => void
  onOpenBrowser?: () => void
  onChoiceSend?: (value: string) => void
  onChoiceDismiss?: () => void
  onChoiceFillComposer?: (value: string) => void
  onChoiceBundleSubmit?: (
    combinedValue: string,
    picks: Array<{ partIndex: number; value: string }>,
    opts?: { omegaChoosesRest?: boolean }
  ) => void
  onChoiceBundleDismiss?: () => void
  choicesDisabled?: boolean
  editableCode?: boolean
  onCodeBlockEdit?: (codeIndex: number, newCode: string, lang: string) => void
}) {
  const thinkingSplit = useMemo(
    () =>
      resolveMessageThinking(message.content, {
        reasoningContent: message.reasoningContent,
        reasoningOpen: message.reasoningOpen
      }),
    [message.content, message.reasoningContent, message.reasoningOpen]
  )

  const showThinking = shouldShowThinkingPanel(thinkingSplit, {
    streaming,
    reasoningOpen: message.reasoningOpen
  })

  const displayMessage = useMemo((): Message => {
    if (!thinkingSplit.thinking && !thinkingSplit.thinkingOpen) return message
    const visible = thinkingSplit.content
    if (message.parts?.length) {
      const parts = message.parts.map((p) =>
        p.type === 'text' ? { ...p, text: visible || p.text } : p
      )
      return { ...message, content: visible || message.content, parts }
    }
    return { ...message, content: visible || message.content }
  }, [message, thinkingSplit.content, thinkingSplit.thinking, thinkingSplit.thinkingOpen])

  const parts = displayMessage.parts?.length
    ? displayMessage.parts
    : [{ type: 'text' as const, text: displayMessage.content }]
  const seenYoutube = { value: false }
  const pendingChoiceCount = parts.filter(
    (p) => p.type === 'choices' && (p.status ?? 'pending') === 'pending'
  ).length
  const useBriefingBundle = pendingChoiceCount >= 2 && onChoiceBundleSubmit && onChoiceBundleDismiss
  let codeBlockCounter = 0

  return (
    <div className="space-y-2">
      {showThinking && (
        <ThinkingPanel
          thinking={thinkingSplit.thinking}
          thinkingOpen={thinkingSplit.thinkingOpen || message.reasoningOpen}
          streaming={streaming}
        />
      )}
      {parts.map((part, i) => {
        if (useBriefingBundle && part.type === 'choices') return null
        if (part.type === 'youtube') {
          if (seenYoutube.value) return null
          seenYoutube.value = true
        }
        const codeOffset = codeBlockCounter
        if (part.type === 'text') {
          const segs = parseMarkdownCodeSegments(part.text || message.content)
          codeBlockCounter += segs.filter((s) => s.type === 'code').length
        }
        return (
          <PartBlock
            key={i}
            part={part}
            sessionId={sessionId}
            fallbackText={displayMessage.content}
            onOpenContentStudio={onOpenContentStudio}
            onOpenBrowser={onOpenBrowser}
            codeBlockIndexOffset={codeOffset}
            onChoiceSend={onChoiceSend}
            onChoiceDismiss={onChoiceDismiss}
            onChoiceFillComposer={onChoiceFillComposer}
            choicesDisabled={choicesDisabled}
            editableCode={editableCode}
            onCodeBlockEdit={onCodeBlockEdit}
            streaming={streaming && i === parts.length - 1}
          />
        )
      })}
      {useBriefingBundle && (
        <BriefingChoicesBundle
          message={message}
          disabled={choicesDisabled}
          onSubmit={onChoiceBundleSubmit}
          onDismissAll={onChoiceBundleDismiss}
          onFillComposer={onChoiceFillComposer}
        />
      )}
    </div>
  )
}

function PartBlock({
  part,
  sessionId,
  fallbackText,
  onOpenContentStudio,
  onOpenBrowser,
  codeBlockIndexOffset = 0,
  onChoiceSend,
  onChoiceDismiss,
  onChoiceFillComposer,
  choicesDisabled,
  editableCode,
  onCodeBlockEdit,
  streaming
}: {
  part: MessagePart
  sessionId: string | null
  fallbackText: string
  onOpenContentStudio?: () => void
  onOpenBrowser?: () => void
  codeBlockIndexOffset?: number
  onChoiceSend?: (value: string) => void
  onChoiceDismiss?: () => void
  onChoiceFillComposer?: (value: string) => void
  choicesDisabled?: boolean
  editableCode?: boolean
  onCodeBlockEdit?: (codeIndex: number, newCode: string, lang: string) => void
  streaming?: boolean
}) {
  if (part.type === 'choices' && onChoiceSend && onChoiceDismiss) {
    return (
      <AssistantChoicesCard
        part={part}
        disabled={choicesDisabled}
        onSend={onChoiceSend}
        onDismiss={onChoiceDismiss}
        onFillComposer={onChoiceFillComposer}
      />
    )
  }
  if (part.type === 'content_studio') {
    return (
      <ContentStudioMessageCard
        part={part}
        sessionId={sessionId}
        onOpenStudio={onOpenContentStudio}
      />
    )
  }
  if (part.type === 'direct_video') {
    return <DirectVideoMessageCard part={part} sessionId={sessionId} />
  }
  if (part.type === 'youtube') {
    return (
      <YouTubeMessageCard embedUrl={part.embedUrl} watchUrl={part.watchUrl} title={part.title} />
    )
  }
  if (part.type === 'text') {
    const text = stripToolArtifacts(part.text || fallbackText)
    if (!text.trim()) return null
    const segments = parseMarkdownCodeSegments(text)
    const hasCode = segments.some((s) => s.type === 'code')
    if (!hasCode) {
      return (
        <OmegaChatMarkdown
          text={text}
          codeBlockIndexOffset={codeBlockIndexOffset}
          editableCode={editableCode}
          onCodeBlockEdit={onCodeBlockEdit}
          onOpenBrowser={onOpenBrowser}
          streaming={streaming}
        />
      )
    }
    let codeIdx = codeBlockIndexOffset
    let proseIdx = 0
    const proseCount = segments.filter((s) => s.type === 'prose' && s.text.trim()).length
    return (
      <div className="space-y-2">
        {segments.map((seg, si) => {
          if (seg.type === 'code') {
            const block = (
              <ChatCodeBlock
                key={`code-${si}`}
                code={seg.code}
                lang={seg.lang}
                index={codeIdx}
                maxHeight="none"
                editable={editableCode}
                onOpenBrowser={onOpenBrowser}
                onCodeChange={
                  onCodeBlockEdit
                    ? (newCode) => onCodeBlockEdit(codeIdx, newCode, seg.lang)
                    : undefined
                }
              />
            )
            codeIdx += 1
            return block
          }
          if (!seg.text.trim()) return null
          proseIdx += 1
          return (
            <OmegaChatMarkdown
              key={`prose-${si}`}
              text={seg.text}
              codeBlockIndexOffset={codeIdx}
              editableCode={editableCode}
              onCodeBlockEdit={onCodeBlockEdit}
              onOpenBrowser={onOpenBrowser}
              streaming={streaming && proseIdx === proseCount}
            />
          )
        })}
      </div>
    )
  }

  if (!sessionId) {
    return <p className="text-xs text-zinc-500">[attachment]</p>
  }

  if (part.type === 'image' || part.type === 'audio') {
    return null
  }

  if (part.type === 'video') {
    return (
      <div className="space-y-1">
        <video
          controls
          className="max-h-64 max-w-full rounded-lg [overflow-anchor:none]"
          src={sessionMediaUrl(sessionId, part.ref)}
        >
          <track kind="captions" />
        </video>
        <ReviewInPanelButton sessionId={sessionId} part={part} />
      </div>
    )
  }

  if (part.type === 'file') {
    return (
      <a
        href={sessionMediaUrl(sessionId, part.ref)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-sm text-zinc-200 hover:border-indigo-500"
      >
        <span className="font-medium">{part.name}</span>
        {part.sizeBytes != null && (
          <span className="text-xs text-zinc-500">{Math.round(part.sizeBytes / 1024)} KB</span>
        )}
      </a>
    )
  }

  return null
}
