import type { Dispatch, SetStateAction } from 'react'
import type { Message } from '@omega/sdk'
import type { Page } from '../App'
import { formatSlashHelpText } from './slash-commands-catalog'
import { engineClient } from './engine'

export interface SlashContext {
  setAgentMode: (v: boolean | ((p: boolean) => boolean)) => void
  setSystemPrompt: (s: string) => void
  setInput: (s: string) => void
  setSessionId: (id: string | null) => void
  setMessages: Dispatch<SetStateAction<Message[]>>
  messages: Message[]
  sessionId: string | null
  navigate: (page: Page) => void
  runTool?: (name: string, args: Record<string, string>) => Promise<string>
}

export interface SlashResult {
  handled: boolean
  message?: string
}

export async function runSlashCommand(cmdLine: string, ctx: SlashContext): Promise<SlashResult> {
  const [c, ...rest] = cmdLine.trim().split(/\s+/)
  const arg = rest.join(' ')

  switch (c) {
    case '/new':
      ctx.setSessionId(null)
      ctx.setMessages([])
      ctx.setInput('')
      return { handled: true }
    case '/clear':
      ctx.setMessages(() => [])
      ctx.setInput('')
      return { handled: true }
    case '/retry': {
      const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user')
      if (lastUser) {
        ctx.setMessages((m) => m.slice(0, -2))
        ctx.setInput(lastUser.content)
      }
      return { handled: true }
    }
    case '/agent':
      ctx.setAgentMode((v) => !v)
      ctx.setInput('')
      return { handled: true, message: 'Agent mode toggled' }
    case '/system':
      ctx.setSystemPrompt(arg || '')
      ctx.setInput('')
      return { handled: true }
    case '/usage': {
      const summary = await engineClient.usage.summary(ctx.sessionId ?? undefined)
      return {
        handled: true,
        message: `Tokens in: ${summary.totalTokensIn}\nTokens out: ${summary.totalTokensOut}\nEst. cost: $${summary.totalCostUsd.toFixed(4)}\nRecords: ${summary.records.length}`
      }
    }
    case '/save':
      if (arg)
        await engineClient.memory.add('fact', arg.slice(0, 2000), ctx.sessionId ?? undefined)
      else {
        const last = ctx.messages[ctx.messages.length - 1]?.content
        if (last)
          await engineClient.memory.add('fact', last.slice(0, 2000), ctx.sessionId ?? undefined)
      }
      ctx.setInput('')
      return { handled: true, message: 'Saved to memory' }
    case '/memory':
      ctx.navigate('memory')
      ctx.setInput('')
      return { handled: true }
    case '/web':
      if (arg && ctx.runTool) {
        const r = await ctx.runTool('web_fetch', { url: arg })
        return { handled: true, message: r }
      }
      return { handled: true, message: 'Usage: /web <url>' }
    case '/browse':
      if (arg && ctx.runTool) {
        await ctx.runTool('browser_navigate', { url: arg })
        ctx.navigate('browser')
        return { handled: true, message: `Opened ${arg}` }
      }
      return { handled: true, message: 'Usage: /browse <url>' }
    case '/image':
      if (arg && ctx.sessionId && ctx.runTool) {
        const r = await ctx.runTool('image_generate', { sessionId: ctx.sessionId, prompt: arg })
        return { handled: true, message: r }
      }
      return { handled: true, message: 'Usage: /image <prompt> (requires active session)' }
    case '/code':
      if (arg && ctx.runTool) {
        const r = await ctx.runTool('run_python', { code: arg })
        return { handled: true, message: r }
      }
      return { handled: true, message: 'Usage: /code <python>' }
    case '/shell':
      if (arg && ctx.runTool) {
        const r = await ctx.runTool('run_shell', { command: arg })
        return { handled: true, message: r }
      }
      return { handled: true, message: 'Usage: /shell <command> (enable + approve run_shell)' }
    case '/moa':
      if (arg) {
        const out = await engineClient.workforce.runMoA(arg)
        return { handled: true, message: out.slice(0, 500) }
      }
      return { handled: true, message: 'Usage: /moa <task>' }
    case '/delegate': {
      const [agentId, ...taskParts] = rest
      if (agentId && taskParts.length) {
        const out = await engineClient.workforce.delegate(agentId, taskParts.join(' '))
        return { handled: true, message: out.slice(0, 500) }
      }
      return { handled: true, message: 'Usage: /delegate <agentId> <task>' }
    }
    case '/janitor':
      if (ctx.sessionId) {
        const r = await engineClient.selfImprove.janitor(ctx.sessionId)
        return { handled: true, message: r.note }
      }
      return { handled: true, message: 'No active session' }
    case '/reflect':
      if (ctx.sessionId) {
        const e = await engineClient.selfImprove.reflect(ctx.sessionId)
        return { handled: true, message: e?.insight ?? 'Nothing to reflect' }
      }
      return { handled: true, message: 'No active session' }
    case '/office':
      ctx.navigate('office')
      ctx.setInput('')
      return { handled: true }
    case '/gateway':
      ctx.navigate('gateway')
      ctx.setInput('')
      return { handled: true }
    case '/skills':
    case '/kanban':
    case '/schedules':
    case '/models':
    case '/soul':
    case '/mcp':
    case '/providers':
    case '/tools':
    case '/docs':
    case '/browser':
      ctx.navigate(c.slice(1) as Page)
      ctx.setInput('')
      return { handled: true }
    case '/plan':
      if (arg && ctx.runTool) {
        const r = await ctx.runTool('plan_tasks', { goal: arg })
        return { handled: true, message: r }
      }
      return { handled: true, message: 'Usage: /plan <goal>' }
    case '/parallel':
      if (arg) {
        try {
          const tasks = JSON.parse(arg) as Array<{ agentId: string; task: string }>
          const out = await engineClient.workforce.runParallel(tasks)
          return { handled: true, message: out.join('\n---\n').slice(0, 600) }
        } catch {
          return { handled: true, message: 'Usage: /parallel [{"agentId":"executor","task":"…"}]' }
        }
      }
      return { handled: true, message: 'Usage: /parallel <json array>' }
    case '/pr':
      if (arg) {
        await engineClient.office.addMonitor({
          title: 'Pull request',
          kind: 'pr',
          summary: 'Loading…',
          url: arg.trim()
        })
        ctx.navigate('office')
        return { handled: true, message: 'PR monitor added' }
      }
      return { handled: true, message: 'Usage: /pr <github pr url>' }
    case '/jira':
      if (arg) {
        await engineClient.office.addMonitor({
          title: 'Jira issue',
          kind: 'jira',
          summary: arg.trim(),
          url: arg.includes('/') ? arg.trim() : undefined
        })
        ctx.navigate('office')
        return { handled: true, message: 'Jira monitor added' }
      }
      return { handled: true, message: 'Usage: /jira <key or url>' }
    case '/gym':
      ctx.navigate('office')
      setTimeout(() => void engineClient.office.skillGym(), 100)
      return { handled: true, message: 'Skill gym started — see Office' }
    case '/help':
      return { handled: true, message: formatSlashHelpText() }
    default:
      return { handled: false }
  }
}
