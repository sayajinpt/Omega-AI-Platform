/**
 * In-app text editor tabs (Notepad++-style) shared between Chat code bubbles and Text Editor page.
 */
import { detectLanguage } from './editor-languages'

export type EditorTab = {
  id: string
  title: string
  path: string | null
  content: string
  language: string
  dirty: boolean
  /** Chat-originated snippet — not yet saved to disk */
  source?: 'chat' | 'file' | 'new'
}

type Listener = () => void

let tabs: EditorTab[] = []
let activeId: string | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const fn of listeners) fn()
}

function newId(): string {
  return `ed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function subscribeEditorSession(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getEditorTabs(): EditorTab[] {
  return tabs
}

export function getActiveEditorTab(): EditorTab | null {
  return tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null
}

export function getActiveEditorTabId(): string | null {
  return activeId ?? tabs[0]?.id ?? null
}

export function setActiveEditorTab(id: string): void {
  if (!tabs.some((t) => t.id === id)) return
  activeId = id
  emit()
}

export function openEditorTab(opts: {
  content: string
  language?: string
  title?: string
  path?: string | null
  source?: EditorTab['source']
  activate?: boolean
}): EditorTab {
  const language = detectLanguage(opts.language ?? 'text', opts.content)
  const existing =
    opts.path != null ? tabs.find((t) => t.path === opts.path && !t.dirty) : undefined
  if (existing && opts.path) {
    existing.content = opts.content
    existing.language = language
    if (opts.activate !== false) activeId = existing.id
    emit()
    if (opts.activate !== false) navigateToEditor()
    return existing
  }
  const tab: EditorTab = {
    id: newId(),
    title: opts.title ?? opts.path?.split(/[/\\]/).pop() ?? `Untitled-${tabs.length + 1}`,
    path: opts.path ?? null,
    content: opts.content,
    language,
    dirty: false,
    source: opts.source ?? (opts.path ? 'file' : 'new')
  }
  tabs = [...tabs, tab]
  if (opts.activate !== false) activeId = tab.id
  emit()
  if (opts.activate !== false) navigateToEditor()
  return tab
}

export function updateEditorTab(
  id: string,
  patch: Partial<Pick<EditorTab, 'content' | 'language' | 'title' | 'path' | 'dirty'>>
): void {
  tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch, dirty: patch.dirty ?? t.dirty } : t))
  emit()
}

export function closeEditorTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  tabs = tabs.filter((t) => t.id !== id)
  if (activeId === id) {
    activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
  }
  emit()
}

export function navigateToEditor(): void {
  window.dispatchEvent(new CustomEvent('omega:navigate-editor'))
}
