import { SLASH_COMMANDS, type SlashCommandDef } from '../lib/slash-commands-catalog'

const CATEGORY_ORDER: SlashCommandDef['category'][] = [
  'session',
  'chat',
  'memory',
  'tools',
  'workforce',
  'office',
  'nav',
  'meta'
]

const CATEGORY_LABEL: Record<SlashCommandDef['category'], string> = {
  session: 'Session',
  chat: 'Chat',
  memory: 'Memory',
  tools: 'Tools',
  workforce: 'Workforce',
  office: 'Office',
  nav: 'Navigate',
  meta: 'Help'
}

export function SlashHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-labelledby="slash-help-title"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h2 id="slash-help-title" className="text-base font-semibold">
              Slash commands
            </h2>
            <p className="text-xs text-zinc-500">Type /help in chat anytime · {SLASH_COMMANDS.length} commands</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Close
          </button>
        </header>
        <div className="overflow-y-auto px-4 py-3">
          {CATEGORY_ORDER.map((cat) => {
            const cmds = SLASH_COMMANDS.filter((c) => c.category === cat)
            if (!cmds.length) return null
            return (
              <section key={cat} className="mb-4">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  {CATEGORY_LABEL[cat]}
                </h3>
                <ul className="space-y-2">
                  {cmds.map((c) => (
                    <li
                      key={c.command}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <code className="font-mono text-xs text-indigo-300">{c.usage ?? c.command}</code>
                        <span className="text-xs text-zinc-400">{c.summary}</span>
                      </div>
                      {c.example && (
                        <p className="mt-1 font-mono text-[10px] text-zinc-600">e.g. {c.example}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
