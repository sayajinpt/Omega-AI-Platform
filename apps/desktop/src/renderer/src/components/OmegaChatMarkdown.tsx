import { useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { ChatCodeBlock } from './ChatCodeBlock'
import { StreamingCursor } from './StreamingCursor'

/** Prose markdown that renders fenced blocks with the same ChatCodeBlock bubbles as tool output. */
export function OmegaChatMarkdown({
  text,
  codeBlockIndexOffset = 0,
  editableCode,
  onCodeBlockEdit,
  onOpenBrowser,
  streaming
}: {
  text: string
  codeBlockIndexOffset?: number
  editableCode?: boolean
  onCodeBlockEdit?: (codeIndex: number, newCode: string, lang: string) => void
  onOpenBrowser?: () => void
  streaming?: boolean
}) {
  const nextIndex = useRef(codeBlockIndexOffset)

  const components = useMemo((): Components => {
    nextIndex.current = codeBlockIndexOffset
    return {
      code({ className, children, ...props }) {
        const inline = !className && !String(children).includes('\n')
        if (inline) {
          return (
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-[0.85em]" {...props}>
              {children}
            </code>
          )
        }
        const match = /language-([\w-]+)/i.exec(className ?? '')
        const lang = match?.[1] ?? 'text'
        const code = String(children).replace(/\n$/, '')
        const idx = nextIndex.current
        nextIndex.current += 1
        return (
          <ChatCodeBlock
            code={code}
            lang={lang}
            index={idx}
            editable={editableCode}
            onOpenBrowser={onOpenBrowser}
            onCodeChange={
              onCodeBlockEdit ? (newCode) => onCodeBlockEdit(idx, newCode, lang) : undefined
            }
          />
        )
      },
      pre({ children }) {
        return <>{children}</>
      }
    }
  }, [codeBlockIndexOffset, editableCode, onCodeBlockEdit, onOpenBrowser])

  return (
    <div className="omega-chat-prose prose prose-invert prose-sm max-w-none min-w-0 break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
      {streaming ? <StreamingCursor /> : null}
    </div>
  )
}
