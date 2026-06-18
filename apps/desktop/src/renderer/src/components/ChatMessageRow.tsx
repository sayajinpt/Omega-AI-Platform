import { memo } from 'react'
import type { Message } from '@omega/sdk'
import { handleBubbleWheel } from '../lib/bubble-scroll'
import { MessageContent } from './MessageContent'
import { CopyMessageButton } from './CopyMessageButton'
import { StreamingCursor } from './StreamingCursor'

export type ChatMessageRowProps = {
  message: Message
  index: number
  sessionId: string | null
  streaming: boolean
  isActiveStream?: boolean
  selected: boolean
  showRegenerate: boolean
  onSelectUser: () => void
  onOpenEdit: () => void
  onRegenerate: () => void
  onNavigateContentStudio?: () => void
  onOpenBrowser?: () => void
  onCodeBlockEdit?: (codeIndex: number, newCode: string, lang: string) => void
  onChoiceSend?: (value: string) => void
  onChoiceDismiss?: () => void
  onChoiceFillComposer?: (value: string) => void
  onChoiceBundleSubmit?: (
    combined: string,
    picks: Array<{ partIndex: number; value: string }>,
    opts?: { omegaChoosesRest?: boolean }
  ) => void
  onChoiceBundleDismiss?: () => void
}

function ChatMessageRowInner({
  message: m,
  index: i,
  sessionId,
  streaming,
  isActiveStream,
  selected,
  showRegenerate,
  onSelectUser,
  onOpenEdit,
  onRegenerate,
  onNavigateContentStudio,
  onOpenBrowser,
  onCodeBlockEdit,
  onChoiceSend,
  onChoiceDismiss,
  onChoiceFillComposer,
  onChoiceBundleSubmit,
  onChoiceBundleDismiss
}: ChatMessageRowProps) {
  const hasChoices = m.role === 'assistant' && m.parts?.some((p) => p.type === 'choices')

  return (
    <div
      role={m.role === 'user' ? 'button' : undefined}
      tabIndex={m.role === 'user' && !streaming ? 0 : undefined}
      onClick={() => {
        if (m.role === 'user' && !streaming) onSelectUser()
      }}
      onDoubleClick={() => {
        if (m.role === 'user' && !streaming) onOpenEdit()
      }}
      onKeyDown={(e) => {
        if (m.role !== 'user' || streaming) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenEdit()
        }
      }}
      className={`omega-chat-bubble group relative mb-3 rounded-xl px-4 py-2 outline-none ${
        m.role === 'user' ? 'omega-chat-user ml-auto cursor-pointer' : 'omega-chat-assistant mr-auto'
      } ${selected ? 'ring-2 ring-[var(--omega-accent)]/70' : ''}`}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <span className="text-xs uppercase text-zinc-500">{m.role}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <CopyMessageButton content={m.content} parts={m.parts} />
          {!streaming && (
            <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
              {m.role === 'user' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenEdit()
                  }}
                  className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-indigo-200"
                  title="Edit message (Ctrl+E)"
                >
                  Edit
                </button>
              )}
              {showRegenerate && (
                <button
                  type="button"
                  onClick={() => void onRegenerate()}
                  className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-cyan-200"
                  title="Regenerate this reply"
                >
                  Regenerate
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {m.content || m.parts?.length || isActiveStream ? (
        <div
          className="omega-chat-bubble-scroll max-h-[min(70vh,540px)] min-h-0 overflow-y-auto overscroll-contain pr-0.5"
          onWheel={handleBubbleWheel}
        >
          {m.content?.trim() || m.parts?.length ? (
            <MessageContent
              message={m}
              sessionId={sessionId}
              streaming={Boolean(isActiveStream)}
              onOpenContentStudio={onNavigateContentStudio}
              onOpenBrowser={onOpenBrowser}
              editableCode={m.role === 'assistant' && !streaming}
              onCodeBlockEdit={m.role === 'assistant' && !streaming ? onCodeBlockEdit : undefined}
              choicesDisabled={streaming}
              onChoiceSend={hasChoices ? onChoiceSend : undefined}
              onChoiceDismiss={hasChoices ? onChoiceDismiss : undefined}
              onChoiceFillComposer={m.role === 'assistant' ? onChoiceFillComposer : undefined}
              onChoiceBundleSubmit={onChoiceBundleSubmit}
              onChoiceBundleDismiss={onChoiceBundleDismiss}
            />
          ) : (
            <StreamingCursor />
          )}
        </div>
      ) : (
        <span className="italic text-zinc-500">…</span>
      )}
    </div>
  )
}

export const ChatMessageRow = memo(ChatMessageRowInner)
