import type { EditorView } from '@codemirror/view'

let focusedEditorView: EditorView | null = null

export function setFocusedEditorView(view: EditorView | null): void {
  focusedEditorView = view
}

export function getFocusedEditorView(): EditorView | null {
  return focusedEditorView
}

const viewByRoot = new WeakMap<HTMLElement, EditorView>()

export function registerEditorView(root: HTMLElement, view: EditorView): void {
  viewByRoot.set(root, view)
}

export function unregisterEditorView(root: HTMLElement): void {
  const view = viewByRoot.get(root)
  viewByRoot.delete(root)
  if (view && focusedEditorView === view) focusedEditorView = null
}

export function getEditorViewFromTarget(target: EventTarget | null): EditorView | null {
  if (!(target instanceof Node)) return focusedEditorView
  const el = target instanceof Element ? target : target.parentElement
  const root = el?.closest('.cm-editor') as HTMLElement | null
  if (root) return viewByRoot.get(root) ?? null
  return focusedEditorView
}
