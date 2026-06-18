/** Structured slash command reference for in-app help and /help. */
export interface SlashCommandDef {
  command: string
  summary: string
  usage?: string
  example?: string
  category: 'session' | 'chat' | 'memory' | 'tools' | 'workforce' | 'office' | 'nav' | 'meta'
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { command: '/new', summary: 'New chat session', category: 'session' },
  { command: '/clear', summary: 'Clear messages in current session', category: 'session' },
  { command: '/retry', summary: 'Retry last user message', category: 'session' },
  { command: '/agent', summary: 'Toggle agent mode (tools + memory)', category: 'chat' },
  { command: '/system', summary: 'Set system prompt for this chat', usage: '/system <text>', category: 'chat' },
  { command: '/usage', summary: 'Token and cost summary for session', category: 'chat' },
  { command: '/save', summary: 'Save text to memory', usage: '/save [text]', example: '/save Project uses pnpm', category: 'memory' },
  { command: '/memory', summary: 'Open Memory page', category: 'memory' },
  { command: '/reflect', summary: 'Reflect on session → self-improve log + memory', category: 'memory' },
  { command: '/janitor', summary: 'Trim long session (uses Settings janitor rules)', category: 'memory' },
  { command: '/web', summary: 'Fetch URL (web_fetch tool)', usage: '/web <url>', category: 'tools' },
  { command: '/browse', summary: 'Open URL in in-app browser', usage: '/browse <url>', category: 'tools' },
  { command: '/image', summary: 'Generate image in session', usage: '/image <prompt>', category: 'tools' },
  { command: '/code', summary: 'Run Python (run_python tool)', usage: '/code <python>', category: 'tools' },
  { command: '/shell', summary: 'Run shell in workspace (approval required)', usage: '/shell <cmd>', category: 'tools' },
  { command: '/plan', summary: 'Plan tasks for a goal', usage: '/plan <goal>', category: 'tools' },
  { command: '/moa', summary: 'Mixture-of-agents workforce run', usage: '/moa <task>', category: 'workforce' },
  { command: '/delegate', summary: 'Delegate to one agent', usage: '/delegate <agentId> <task>', category: 'workforce' },
  { command: '/parallel', summary: 'Parallel agent tasks (JSON array)', usage: '/parallel [{"agentId":"executor","task":"…"}]', category: 'workforce' },
  { command: '/pr', summary: 'Add GitHub PR monitor', usage: '/pr <url>', category: 'office' },
  { command: '/jira', summary: 'Add Jira issue monitor', usage: '/jira <key or url>', category: 'office' },
  { command: '/gym', summary: 'Run skill gym (Office)', category: 'office' },
  { command: '/office', summary: 'Open Office', category: 'nav' },
  { command: '/gateway', summary: 'Open messaging gateway', category: 'nav' },
  { command: '/skills', summary: 'Open Skills', category: 'nav' },
  { command: '/kanban', summary: 'Open Kanban', category: 'nav' },
  { command: '/schedules', summary: 'Open Schedules', category: 'nav' },
  { command: '/models', summary: 'Open Model Studio', category: 'nav' },
  { command: '/soul', summary: 'Open Soul', category: 'nav' },
  { command: '/mcp', summary: 'Open MCP', category: 'nav' },
  { command: '/providers', summary: 'Open Providers', category: 'nav' },
  { command: '/tools', summary: 'Open Tools', category: 'nav' },
  { command: '/docs', summary: 'Open Docs', category: 'nav' },
  { command: '/browser', summary: 'Open Browser', category: 'nav' },
  { command: '/help', summary: 'Show this command list', category: 'meta' }
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

export function formatSlashHelpText(): string {
  const byCat = new Map<string, SlashCommandDef[]>()
  for (const c of SLASH_COMMANDS) {
    const label = CATEGORY_LABEL[c.category]
    if (!byCat.has(label)) byCat.set(label, [])
    byCat.get(label)!.push(c)
  }
  const lines: string[] = ['Omega slash commands', '']
  for (const [label, cmds] of byCat) {
    lines.push(`${label}:`)
    for (const c of cmds) {
      const usage = c.usage ?? c.command
      lines.push(`  ${usage} — ${c.summary}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}
