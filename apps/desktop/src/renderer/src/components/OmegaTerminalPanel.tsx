import { engineClient } from '../lib/engine'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalLine } from '@omega/sdk'

const TERMINAL_OPEN_EVENT = 'omega:terminal-open'

const KIND_COLOR: Record<TerminalLine['kind'], string> = {
  info: 'text-zinc-500',
  cmd: 'text-indigo-300',
  stdout: 'text-zinc-300',
  stderr: 'text-amber-300/90',
  error: 'text-rose-400',
  ok: 'text-emerald-400'
}

export function OmegaTerminalPanel({
  sessionId,
  onOpenBrowser
}: {
  sessionId?: string | null
  onOpenBrowser?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [unread, setUnread] = useState(0)
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openRef = useRef(open)

  useEffect(() => {
    openRef.current = open
  }, [open])

  const reload = useCallback(async () => {
    setLines(await engineClient.terminal.history())
  }, [])

  useEffect(() => {
    void reload()
    return engineClient.terminal.onLine((line) => {
      setLines((prev) => [...prev, line].slice(-800))
      if (!openRef.current) setUnread((n) => n + 1)
    })
  }, [reload])

  useEffect(() => {
    const onOpen = () => {
      setOpen(true)
      setUnread(0)
      void reload()
    }
    window.addEventListener(TERMINAL_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(TERMINAL_OPEN_EVENT, onOpen)
  }, [reload])

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      inputRef.current?.focus()
    }
  }, [lines, open])

  const runCommand = async () => {
    const cmd = command.trim()
    if (!cmd || running) return
    setRunning(true)
    setCommand('')
    if (!open) {
      setOpen(true)
      setUnread(0)
    }
    try {
      await engineClient.terminal.runCommand(cmd, {
        sessionId: sessionId ?? undefined
      })
    } finally {
      setRunning(false)
      inputRef.current?.focus()
    }
  }

  const toggle = () => {
    setOpen((o) => {
      if (!o) setUnread(0)
      return !o
    })
  }

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-xs text-zinc-400 hover:bg-zinc-900/80"
      >
        <span className="font-medium text-zinc-300">
          Terminal
          {unread > 0 && !open ? (
            <span className="ml-2 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] text-white">
              {unread}
            </span>
          ) : null}
        </span>
        <span>{open ? '▼ Hide' : '▲ Show'} — runs, scripts, shell</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800">
          <div className="flex items-center justify-end gap-2 px-3 py-1.5">
            {onOpenBrowser ? (
              <button
                type="button"
                className="text-[10px] text-indigo-400 hover:underline"
                onClick={onOpenBrowser}
              >
                Open browser tab
              </button>
            ) : null}
            <button
              type="button"
              className="text-[10px] text-zinc-500 hover:text-zinc-300"
              onClick={() => void engineClient.terminal.clear().then(reload)}
            >
              Clear
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto px-3 pb-2 font-mono text-[10px] leading-relaxed">
            {lines.length === 0 ? (
              <p className="text-zinc-600">
                Type a command below (dir, python code/script.py, ping, git, …). Output from Run on
                code blocks also appears here.
              </p>
            ) : (
              lines.map((line) => (
                <div key={line.id} className={`whitespace-pre-wrap ${KIND_COLOR[line.kind]}`}>
                  <span className="mr-2 opacity-40">
                    {new Date(line.at).toLocaleTimeString()}
                  </span>
                  {line.text}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
          <form
            className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              void runCommand()
            }}
          >
            <span className="shrink-0 font-mono text-[11px] text-emerald-500/90">&gt;</span>
            <input
              ref={inputRef}
              type="text"
              value={command}
              disabled={running}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={running ? 'Running…' : 'Enter command'}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-50"
              aria-label="Terminal command"
            />
            <button
              type="submit"
              disabled={running || !command.trim()}
              className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Run
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
