import { gotoLine, openSearchPanel } from '@codemirror/search'
import { getFocusedEditorView } from './editor-view-registry'

export function handleContextFind(): void {
  const view = getFocusedEditorView()
  if (view) {
    openSearchPanel(view)
    return
  }
  const sel = window.getSelection()?.toString()
  if (sel) void navigator.clipboard.writeText(sel)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
}

export function handleContextGotoLine(): void {
  const view = getFocusedEditorView()
  if (view) {
    gotoLine(view)
    return
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))
}
