import { createTheme } from '@uiw/codemirror-themes'
import { tags as t } from '@lezer/highlight'

/** Dark editor theme aligned with Omega zinc UI */
export const omegaEditorTheme = createTheme({
  theme: 'dark',
  settings: {
    background: '#09090b',
    foreground: '#e4e4e7',
    caret: '#a5b4fc',
    selection: '#312e81aa',
    selectionMatch: '#4338ca66',
    lineHighlight: '#18181b',
    gutterBackground: '#0c0c0e',
    gutterForeground: '#52525b',
    gutterBorder: 'transparent'
  },
  styles: [
    { tag: t.comment, color: '#71717a', fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string)], color: '#86efac' },
    { tag: t.number, color: '#fcd34d' },
    { tag: t.bool, color: '#f9a8d4' },
    { tag: t.null, color: '#f9a8d4' },
    { tag: t.keyword, color: '#c4b5fd' },
    { tag: t.operator, color: '#a1a1aa' },
    { tag: t.className, color: '#67e8f9' },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: '#93c5fd' },
    { tag: t.variableName, color: '#e4e4e7' },
    { tag: t.definition(t.variableName), color: '#93c5fd' },
    { tag: t.function(t.variableName), color: '#fcd34d' },
    { tag: t.tagName, color: '#f472b6' },
    { tag: t.angleBracket, color: '#71717a' },
    { tag: t.attributeName, color: '#a5b4fc' },
    { tag: t.meta, color: '#71717a' }
  ]
})
