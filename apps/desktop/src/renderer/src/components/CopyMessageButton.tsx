import { useState, type MouseEvent } from 'react'

function messagePlainText(content: string, parts?: { type: string; text?: string }[]): string {
  if (parts?.length) {
    return parts
      .map((p) => (p.type === 'text' && p.text ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim() || content
  }
  return content
}

export function CopyMessageButton({
  content,
  parts
}: {
  content: string
  parts?: { type: string; text?: string }[]
}) {
  const [copied, setCopied] = useState(false)
  const text = messagePlainText(content, parts)
  if (!text.trim()) return null

  const onCopy = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => void onCopy(e)}
      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      title={copied ? 'Copied' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied' : 'Copy message'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  )
}
