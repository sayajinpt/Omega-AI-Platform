import { engineClient } from '../lib/engine'
import { useEffect, useRef, useState } from 'react'
import { OmegaCodeEditor } from './editor/OmegaCodeEditor'
import { detectLanguage, extForLanguage } from '../lib/editor-languages'
import { navigateToEditor, openEditorTab } from '../lib/editor-session'
import { requestOmegaBrowser } from '../lib/open-omega-browser'
import { t } from '../i18n'

function pathToBrowserUrl(filePath: string): string {
  const trimmed = filePath.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('file://')) return trimmed
  const normalized = trimmed.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
  if (normalized.startsWith('/')) return `file://${normalized}`
  return `file:///${normalized}`
}

export function ChatCodeBlock({
  code,
  lang,
  index,
  editable = true,
  onCodeChange,
  onOpenBrowser
}: {
  code: string
  lang: string
  index: number
  editable?: boolean
  onCodeChange?: (code: string) => void
  onOpenBrowser?: () => void
}) {
  const [draft, setDraft] = useState(code)
  const [dirty, setDirty] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const userEditedRef = useRef(false)

  const resolvedLang = detectLanguage(lang, draft)
  const lines = draft.split('\n').length
  const defaultName = `omega-${resolvedLang}-${index + 1}.${extForLanguage(resolvedLang)}`

  useEffect(() => {
    if (!userEditedRef.current) setDraft(code)
  }, [code])

  const applyChange = (next: string) => {
    userEditedRef.current = true
    setDirty(next !== code)
    setDraft(next)
    onCodeChange?.(next)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft)
      setMsg(t('codeBubble.copied'))
      setTimeout(() => setMsg(null), 2000)
    } catch {
      setMsg(t('codeBubble.copyFailed'))
    }
  }

  const deleteSavedFile = async () => {
    if (!savedPath) return
    const name = savedPath.split(/[/\\]/).pop() ?? savedPath
    if (!confirm(t('codeBubble.deleteConfirm', { path: name }))) return
    setBusy(true)
    try {
      await engineClient.editor.deleteFile(savedPath)
      setSavedPath(null)
      setMsg(t('codeBubble.deleted', { path: name }))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveToDisk = async (forceSaveAs = false) => {
    setBusy(true)
    try {
      if (savedPath && !forceSaveAs) {
        await engineClient.editor.write(savedPath, draft)
        setDirty(false)
        setMsg(t('codeBubble.savedTo', { path: savedPath.split(/[/\\]/).pop() ?? savedPath }))
        return
      }
      const path = await engineClient.editor.saveAs(draft, savedPath ?? defaultName)
      if (path) {
        setSavedPath(path)
        setDirty(false)
        setMsg(t('codeBubble.savedTo', { path: path.split(/[/\\]/).pop() ?? path }))
      } else {
        setMsg(t('codeBubble.saveCancelled'))
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    setBusy(true)
    try {
      const name = await engineClient.terminal.saveSnippet(draft, defaultName)
      setMsg(name ? t('codeBubble.savedTo', { path: name.split(/[/\\]/).pop() ?? name }) : t('codeBubble.saveCancelled'))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setBusy(true)
    window.dispatchEvent(new CustomEvent('omega:terminal-open'))
    try {
      const r = await engineClient.terminal.runSnippet({
        lang: resolvedLang,
        code: draft,
        path: savedPath ?? undefined,
        suggestedName: savedPath ? undefined : defaultName
      })
      if (r.script) setSavedPath(r.script)
      if (r.ok) {
        const previewPath = r.script ?? savedPath
        if (resolvedLang === 'html' && previewPath) {
          setMsg(t('codeBubble.openedBrowser'))
          requestOmegaBrowser(pathToBrowserUrl(previewPath))
        } else if (resolvedLang === 'html') {
          setMsg(t('codeBubble.openedBrowser'))
          onOpenBrowser?.()
        } else {
          setMsg(t('codeBubble.running'))
        }
      } else {
        setMsg(r.error ?? t('codeBubble.runFailed'))
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openInEditor = () => {
    openEditorTab({
      content: draft,
      language: resolvedLang,
      title: savedPath?.split(/[/\\]/).pop() ?? `Chat snippet ${index + 1}.${extForLanguage(resolvedLang)}`,
      path: savedPath,
      source: 'chat'
    })
    navigateToEditor()
  }

  const canRun =
    resolvedLang === 'html' ||
    resolvedLang === 'python' ||
    resolvedLang === 'py' ||
    resolvedLang === 'javascript' ||
    resolvedLang === 'js' ||
    resolvedLang === 'shell' ||
    resolvedLang === 'bash' ||
    resolvedLang === 'sh'

  return (
    <div className="omega-code-bubble my-2 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950/90 shadow-lg ring-1 ring-indigo-500/10">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-indigo-950/80 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-indigo-300">
            {resolvedLang}
          </span>
          <span className="text-[10px] text-zinc-500">
            {lines} lines · {draft.length.toLocaleString()} chars
            {dirty ? ` · ${t('codeBubble.edited')}` : ''}
            {savedPath ? ` · ${savedPath.split(/[/\\]/).pop()}` : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ActionBtn label={collapsed ? t('codeBubble.expand') : t('codeBubble.collapse')} onClick={() => setCollapsed((c) => !c)} />
          <ActionBtn label={t('nav.textEditor')} onClick={openInEditor} />
          <ActionBtn
            label={savedPath ? t('common.save') : t('codeBubble.saveAs')}
            onClick={() => void saveToDisk(!savedPath)}
            disabled={busy}
            primary={!!dirty}
          />
          {savedPath ? (
            <>
              <ActionBtn label={t('editor.saveAs')} onClick={() => void saveToDisk(true)} disabled={busy} />
              <ActionBtn
                label={t('codeBubble.deleteFile')}
                onClick={() => void deleteSavedFile()}
                disabled={busy}
                danger
              />
            </>
          ) : null}
          <ActionBtn label={t('codeBubble.copy')} onClick={() => void copy()} disabled={busy} />
          <ActionBtn label={t('codeBubble.download')} onClick={() => void download()} disabled={busy} />
          {canRun ? (
            <ActionBtn
              label={resolvedLang === 'html' ? t('codeBubble.open') : t('codeBubble.run')}
              onClick={() => void run()}
              disabled={busy}
              primary
            />
          ) : null}
        </div>
      </header>
      {!collapsed && (
        <OmegaCodeEditor
          value={draft}
          language={resolvedLang}
          readOnly={!editable}
          minHeight="8rem"
          maxHeight="min(70vh, 560px)"
          onChange={editable ? applyChange : undefined}
        />
      )}
      {msg ? <p className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-400">{msg}</p> : null}
      {editable && !collapsed ? (
        <p className="border-t border-zinc-800/60 px-3 py-1 text-[9px] text-zinc-600">{t('codeBubble.hint')}</p>
      ) : null}
    </div>
  )
}

function ActionBtn({
  label,
  onClick,
  disabled,
  primary,
  danger
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[10px] font-medium disabled:opacity-40 ${
        primary
          ? 'bg-indigo-600 text-white hover:bg-indigo-500'
          : danger
            ? 'border border-rose-800 text-rose-300 hover:bg-rose-950'
            : 'border border-zinc-600 text-zinc-300 hover:bg-zinc-800'
      }`}
    >
      {label}
    </button>
  )
}
