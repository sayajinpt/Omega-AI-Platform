import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import type { Extension } from '@codemirror/state'

export const EDITOR_LANGUAGE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'text', label: 'Plain text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'xml', label: 'XML' },
  { id: 'shell', label: 'Shell' }
]

export function languageExtension(lang: string): Extension[] {
  const l = lang.toLowerCase()
  if (l === 'javascript' || l === 'js' || l === 'jsx') return [javascript({ jsx: true, typescript: false })]
  if (l === 'typescript' || l === 'ts' || l === 'tsx')
    return [javascript({ jsx: true, typescript: true })]
  if (l === 'python' || l === 'py') return [python()]
  if (l === 'html' || l === 'htm') return [html()]
  if (l === 'css') return [css()]
  if (l === 'json' || l === 'jsonl') return [json()]
  if (l === 'markdown' || l === 'md') return [markdown()]
  if (l === 'xml') return [xml()]
  if (l === 'shell' || l === 'bash' || l === 'sh' || l === 'powershell' || l === 'ps1' || l === 'bat' || l === 'cmd')
    return [StreamLanguage.define(shell)]
  return []
}

export function detectLanguage(lang: string, content: string): string {
  const l = lang.toLowerCase()
  if (l && l !== 'text' && l !== 'plaintext') return l
  if (/<!DOCTYPE/i.test(content) || /<html[\s>]/i.test(content)) return 'html'
  if (/^#!.*python/m.test(content) || /^import |^from /m.test(content)) return 'python'
  if (/^\s*[\[{]/.test(content.trim()) && /"\w+"\s*:/.test(content)) return 'json'
  return 'text'
}

export function extForLanguage(lang: string): string {
  const l = lang.toLowerCase()
  if (l === 'html' || l === 'htm') return 'html'
  if (l === 'python' || l === 'py') return 'py'
  if (l === 'javascript' || l === 'js') return 'js'
  if (l === 'typescript' || l === 'ts' || l === 'tsx') return 'ts'
  if (l === 'css') return 'css'
  if (l === 'json') return 'json'
  if (l === 'markdown' || l === 'md') return 'md'
  if (l === 'xml') return 'xml'
  if (l === 'shell' || l === 'bash' || l === 'sh') return 'sh'
  return 'txt'
}
