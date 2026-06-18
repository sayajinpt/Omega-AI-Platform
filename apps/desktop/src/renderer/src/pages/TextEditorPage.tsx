import { engineClient } from '../lib/engine'
import { useCallback, useEffect, useRef, useState } from 'react'
import { OmegaCodeEditor, type OmegaEditorApi } from '../components/editor/OmegaCodeEditor'
import { EditorSplitPane } from '../components/editor/EditorSplitPane'
import {
  closeEditorTab,
  getActiveEditorTab,
  getActiveEditorTabId,
  getEditorTabs,
  openEditorTab,
  setActiveEditorTab,
  subscribeEditorSession,
  updateEditorTab,
  type EditorTab
} from '../lib/editor-session'
import { EDITOR_LANGUAGE_OPTIONS, extForLanguage } from '../lib/editor-languages'
import { t } from '../i18n'

export function TextEditorPage() {
  const [, tick] = useState(0)
  const [wordWrap, setWordWrap] = useState(true)
  const [splitView, setSplitView] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [splitTabId, setSplitTabId] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const primaryApi = useRef<OmegaEditorApi | null>(null)
  const secondaryApi = useRef<OmegaEditorApi | null>(null)

  useEffect(() => subscribeEditorSession(() => tick((n) => n + 1)), [])

  const tabs = getEditorTabs()
  const activeId = getActiveEditorTabId()
  const active = getActiveEditorTab()
  const splitTab = splitTabId ? tabs.find((tab) => tab.id === splitTabId) ?? null : null

  useEffect(() => {
    if (tabs.length === 0) {
      openEditorTab({ content: '', language: 'text', title: 'Untitled-1', source: 'new', activate: true })
    }
  }, [tabs.length])

  useEffect(() => {
    if (splitView && activeId && !splitTabId) setSplitTabId(activeId)
  }, [splitView, activeId, splitTabId])

  const refreshTab = useCallback((tab: EditorTab, content: string, dirty = true) => {
    updateEditorTab(tab.id, { content, dirty })
  }, [])

  const onNew = () => {
    openEditorTab({ content: '', language: 'text', title: `Untitled-${tabs.length + 1}`, source: 'new' })
  }

  const onOpen = async () => {
    setBusy(true)
    try {
      const files = await engineClient.editor.openFiles()
      for (const f of files) {
        openEditorTab({
          content: f.content,
          path: f.path,
          language: f.language,
          title: f.title,
          source: 'file',
          activate: files.length === 1
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const onSaveAs = useCallback(async (tab: EditorTab) => {
    setBusy(true)
    try {
      const suggested = tab.path ?? `snippet.${extForLanguage(tab.language)}`
      const path = await engineClient.editor.saveAs(tab.content, suggested)
      if (path) {
        updateEditorTab(tab.id, { path, dirty: false, title: path.split(/[/\\]/).pop() ?? tab.title })
        setStatus(t('editor.savedTo', { path }))
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const onSave = useCallback(
    async (tab: EditorTab) => {
      if (tab.path) {
        setBusy(true)
        try {
          await engineClient.editor.write(tab.path, tab.content)
          updateEditorTab(tab.id, { dirty: false })
          setStatus(t('editor.savedTo', { path: tab.path }))
        } catch (e) {
          setStatus(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
        return
      }
      await onSaveAs(tab)
    },
    [onSaveAs]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        const tab = getActiveEditorTab()
        if (tab) void onSave(tab)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave])

  const onRun = async (tab: EditorTab) => {
    setBusy(true)
    window.dispatchEvent(new CustomEvent('omega:terminal-open'))
    try {
      const r = await engineClient.terminal.runSnippet({
        lang: tab.language,
        code: tab.content,
        path: tab.path ?? undefined,
        suggestedName: tab.path ? undefined : tab.title
      })
      setStatus(r.ok ? t('editor.ranOk') : r.error ?? t('editor.runFailed'))
    } finally {
      setBusy(false)
    }
  }

  const tryClose = async (tab: EditorTab) => {
    if (tab.dirty) {
      if (!confirm(t('editor.closeConfirm', { title: tab.title }))) return
    }
    if (splitTabId === tab.id) setSplitTabId(null)
    closeEditorTab(tab.id)
  }

  const focusedApi = () => primaryApi.current ?? secondaryApi.current

  const renderPane = (tab: EditorTab, pane: 'primary' | 'secondary', autoFocus: boolean) => (
    <OmegaCodeEditor
      key={tab.id}
      editorKey={tab.id}
      value={tab.content}
      language={tab.language}
      wordWrap={wordWrap}
      fill
      className="h-full min-h-0"
      autoFocus={autoFocus}
      onReady={(api) => {
        if (pane === 'primary') primaryApi.current = api
        else secondaryApi.current = api
      }}
      onChange={(content) => refreshTab(tab, content, true)}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <header className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <h2 className="text-lg font-semibold text-indigo-300">{t('editor.title')}</h2>
        <p className="text-xs text-zinc-500">{t('editor.subtitle')}</p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <ToolBtn label={t('editor.new')} onClick={onNew} disabled={busy} />
        <ToolBtn label={t('editor.open')} onClick={() => void onOpen()} disabled={busy} />
        {active ? (
          <>
            <ToolBtn label={t('common.save')} onClick={() => void onSave(active)} disabled={busy} />
            <ToolBtn label={t('editor.saveAs')} onClick={() => void onSaveAs(active)} disabled={busy} />
            <ToolBtn label={t('editor.find')} onClick={() => focusedApi()?.find()} title="Ctrl+F" />
            <ToolBtn label={t('editor.gotoLine')} onClick={() => focusedApi()?.gotoLine()} title="Ctrl+G" />
            <ToolBtn
              label={wordWrap ? t('editor.wrapOn') : t('editor.wrapOff')}
              onClick={() => setWordWrap((w) => !w)}
            />
            <ToolBtn
              label={splitView ? t('editor.splitOff') : t('editor.splitOn')}
              onClick={() => setSplitView((s) => !s)}
              title={t('editor.splitHint')}
            />
            <select
              value={active.language}
              onChange={(e) => updateEditorTab(active.id, { language: e.target.value, dirty: true })}
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
            >
              {EDITOR_LANGUAGE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <ToolBtn label={t('editor.run')} onClick={() => void onRun(active)} disabled={busy} primary />
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 overflow-x-auto border-b border-zinc-800 bg-zinc-900/40">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveEditorTab(tab.id)}
            className={`group flex max-w-[14rem] shrink-0 items-center gap-1 border-r border-zinc-800 px-3 py-2 text-xs ${
              tab.id === activeId
                ? 'bg-zinc-950 text-indigo-200'
                : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
            }`}
          >
            <span className="truncate">{tab.dirty ? `● ${tab.title}` : tab.title}</span>
            <span
              role="button"
              tabIndex={0}
              className="ml-1 rounded px-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
              onClick={(e) => {
                e.stopPropagation()
                void tryClose(tab)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  void tryClose(tab)
                }
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>

      {splitView && tabs.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/30 px-3 py-1.5 text-[10px] text-zinc-500">
          <span>{t('editor.splitRight')}:</span>
          <select
            value={splitTabId ?? activeId ?? ''}
            onChange={(e) => setSplitTabId(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-300"
          >
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {active ? (
          <EditorSplitPane
            enabled={splitView && !!splitTab && splitTab.id !== active.id}
            ratio={splitRatio}
            onRatioChange={setSplitRatio}
            left={renderPane(active, 'primary', true)}
            right={
              splitTab && splitTab.id !== active.id ? (
                renderPane(splitTab, 'secondary', false)
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-zinc-500">
                  {t('editor.splitPick')}
                </div>
              )
            }
          />
        ) : (
          <p className="p-6 text-sm text-zinc-500">{t('editor.noDocument')}</p>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-500">
        <span>{status || t('editor.ready')}</span>
        {active ? (
          <span>
            {active.content.length.toLocaleString()} chars · {active.language}
            {active.path ? ` · ${active.path}` : ''}
          </span>
        ) : null}
      </footer>
    </div>
  )
}

function ToolBtn({
  label,
  onClick,
  disabled,
  primary,
  title
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
        primary
          ? 'bg-indigo-600 text-white hover:bg-indigo-500'
          : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
      }`}
    >
      {label}
    </button>
  )
}
