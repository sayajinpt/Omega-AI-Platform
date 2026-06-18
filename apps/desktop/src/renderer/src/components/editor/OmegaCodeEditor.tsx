import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { omegaEditorTheme } from '../../lib/editor-theme'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from '@codemirror/search'
import { languageExtension } from '../../lib/editor-languages'
import {
  registerEditorView,
  setFocusedEditorView,
  unregisterEditorView
} from '../../lib/editor-view-registry'

export type OmegaEditorApi = {
  focus: () => void
  find: () => void
  gotoLine: () => void
  view: EditorView
}

export function OmegaCodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  minHeight = '120px',
  maxHeight = 'min(70vh, 560px)',
  className = '',
  autoFocus = false,
  wordWrap = true,
  editorKey,
  fill = false,
  onReady
}: {
  value: string
  onChange?: (value: string) => void
  language: string
  readOnly?: boolean
  minHeight?: string
  maxHeight?: string
  className?: string
  autoFocus?: boolean
  wordWrap?: boolean
  /** Fill parent height and scroll inside the editor (Text Editor page). */
  fill?: boolean
  /** Remount when tab id changes */
  editorKey?: string
  onReady?: (api: OmegaEditorApi) => void
}) {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const viewRef = useRef<EditorView | null>(null)

  const extensions = useMemo(
    () => [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      highlightSelectionMatches(),
      ...(wordWrap ? [EditorView.lineWrapping] : []),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      languageExtension(language),
      EditorView.theme({
        '&': {
          fontSize: '12px',
          ...(fill ? { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } : {})
        },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, Consolas, monospace',
          overflow: 'auto',
          ...(fill ? { flex: 1, minHeight: 0, maxHeight: '100%' } : {})
        },
        '.cm-content': fill ? { minHeight: '4rem' } : { minHeight },
        '&.cm-focused': { outline: 'none' }
      }),
      EditorView.editable.of(!readOnly),
      EditorView.domEventHandlers({
        focus: (_ev, view) => {
          setFocusedEditorView(view)
          return false
        },
        blur: (_ev, view) => {
          if (viewRef.current === view) setFocusedEditorView(null)
          return false
        }
      })
    ],
    [fill, language, minHeight, readOnly, wordWrap]
  )

  const handleCreate = useCallback(
    (view: EditorView) => {
      viewRef.current = view
      const root = view.dom.closest('.cm-editor') as HTMLElement | null
      if (root) registerEditorView(root, view)
      if (autoFocus) setFocusedEditorView(view)
      onReady?.({
        focus: () => view.focus(),
        find: () => openSearchPanel(view),
        gotoLine: () => gotoLine(view),
        view
      })
    },
    [autoFocus, onReady]
  )

  useEffect(() => {
    return () => {
      const view = viewRef.current
      if (view) {
        const root = view.dom.closest('.cm-editor') as HTMLElement | null
        if (root) unregisterEditorView(root)
        if (viewRef.current) setFocusedEditorView(null)
      }
      viewRef.current = null
    }
  }, [editorKey])

  const wrapperClass = [
    'omega-codemirror overflow-hidden',
    fill ? 'omega-codemirror-fill h-full min-h-0' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  const wrapperStyle: CSSProperties = fill
    ? { height: '100%', maxHeight: '100%' }
    : { maxHeight: maxHeight === 'none' ? undefined : maxHeight }

  return (
    <div className={wrapperClass} style={wrapperStyle}>
      <CodeMirror
        ref={ref}
        key={editorKey}
        value={value}
        height={fill ? '100%' : 'auto'}
        theme={omegaEditorTheme}
        extensions={extensions}
        onChange={readOnly ? undefined : onChange}
        onCreateEditor={handleCreate}
        basicSetup={{
          foldGutter: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          highlightActiveLine: false,
          highlightSelectionMatches: false,
          lineNumbers: false,
          searchKeymap: false
        }}
        autoFocus={autoFocus}
      />
    </div>
  )
}
