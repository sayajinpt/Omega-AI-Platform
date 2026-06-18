/**
 * @deprecated Phase 9 — gateway runs in-process via claw3d/office-gateway.ts.
 * Kept for reference; no longer spawned by Omega.
 *
 * OpenClaw-style gateway for Claw3D ↔ Omega.
 * - WebSocket on CLAW3D_ADAPTER_PORT (default 18789)
 * - Forwards chat.send to Omega HTTP API
 * - POST /ingest/presence — workforce snapshot (drives walking avatars via status + agent events)
 */
import http from 'http'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { delimiter, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** ESM does not honor NODE_PATH; resolve ws from packaged claw3d-office node_modules. */
function loadWsModule() {
  const candidates = []
  const fromEnv = process.env.CLAW3D_WS_NODE_MODULES?.trim()
  if (fromEnv) candidates.push(fromEnv)
  for (const part of (process.env.NODE_PATH || '').split(delimiter)) {
    const p = part?.trim()
    if (p) candidates.push(p)
  }
  candidates.push(join(__dirname, '..', 'claw3d-office', 'node_modules'))
  candidates.push(join(__dirname, '..', 'node_modules'))
  for (const dir of candidates) {
    if (!dir || !existsSync(join(dir, 'ws', 'package.json'))) continue
    try {
      return createRequire(join(dir, 'package.json'))('ws')
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Cannot load ws module. Set CLAW3D_WS_NODE_MODULES to a folder containing ws (e.g. claw3d-office/node_modules).'
  )
}

let WebSocketServer
try {
  ;({ WebSocketServer } = loadWsModule())
} catch (e) {
  console.error('[omega-claw3d-adapter] failed to load ws:', e)
  process.exit(1)
}

const OMEGA_API_URL = (process.env.OMEGA_API_URL || 'http://127.0.0.1:9877').replace(/\/$/, '')
const ADAPTER_PORT = parseInt(process.env.CLAW3D_ADAPTER_PORT || '18789', 10)
const EXPECTED_GATEWAY_TOKEN = (process.env.OMEGA_CLAW3D_GATEWAY_TOKEN || process.env.CLAW3D_GATEWAY_TOKEN || '').trim()
const AGENT_ID = 'omega'
const MAIN_KEY = 'main'
const RECENT_ACTIVITY_MS = 45_000

/** @type {Set<(frame: object) => void>} */
const sendFns = new Set()

/**
 * @type {Map<string, {
 *   id: string
 *   name: string
 *   role?: string
 *   status?: string
 *   zone?: string
 *   task?: string
 *   updatedAt: number
 *   runId?: string
 * }>}
 */
const agents = new Map([
  ['planner', { id: 'planner', name: 'Planner', role: 'planner', updatedAt: 0 }],
  ['executor', { id: 'executor', name: 'Executor', role: 'executor', updatedAt: 0 }],
  ['critic', { id: 'critic', name: 'Critic', role: 'critic', updatedAt: 0 }],
  ['researcher', { id: 'researcher', name: 'Researcher', role: 'researcher', updatedAt: 0 }]
])

function isWorkingStatus(status) {
  return (
    status === 'working' ||
    status === 'review' ||
    status === 'standup' ||
    status === 'busy' ||
    status === 'running'
  )
}

function sessionKey(agentId) {
  return `agent:${agentId}:${MAIN_KEY}`
}

function buildStatusSnapshot(now = Date.now()) {
  const recent = []
  const byAgent = []
  for (const a of agents.values()) {
    const key = sessionKey(a.id)
    const active = isWorkingStatus(a.status) && now - a.updatedAt <= RECENT_ACTIVITY_MS
    const updatedAt = active ? now : a.updatedAt || now - 120_000
    const entry = { key, updatedAt }
    recent.push(entry)
    byAgent.push({ agentId: a.id, recent: [entry] })
  }
  return { sessions: { recent, byAgent } }
}

function broadcast(frame) {
  for (const fn of sendFns) {
    try {
      fn(frame)
    } catch {
      /* ignore */
    }
  }
}

function broadcastGatewayState() {
  const now = Date.now()
  const statusSummary = buildStatusSnapshot(now)

  broadcast({
    type: 'event',
    event: 'presence',
    payload: { sessions: statusSummary.sessions }
  })

  for (const a of agents.values()) {
    const active = isWorkingStatus(a.status) && now - a.updatedAt <= RECENT_ACTIVITY_MS
    if (!active) continue
    const runId = a.runId || `omega-${a.id}`
    broadcast({
      type: 'event',
      event: 'agent',
      payload: {
        runId,
        sessionKey: sessionKey(a.id),
        stream: 'lifecycle',
        data: { phase: 'start', text: a.task || a.status }
      }
    })
    broadcast({
      type: 'event',
      event: 'chat',
      payload: {
        runId,
        sessionKey: sessionKey(a.id),
        state: 'delta',
        message: { role: 'assistant', content: a.task || '…' }
      }
    })
  }
}

function ingestAgents(list) {
  const now = Date.now()
  for (const raw of list) {
    const id = String(raw.id ?? '').trim()
    if (!id) continue
    const prev = agents.get(id)
    const status = String(raw.status ?? prev?.status ?? 'idle')
    const working = isWorkingStatus(status)
    agents.set(id, {
      id,
      name: String(raw.name ?? id),
      role: raw.role ? String(raw.role) : prev?.role,
      status,
      zone: raw.zone ? String(raw.zone) : prev?.zone,
      task: raw.task ? String(raw.task) : prev?.task,
      updatedAt: working ? now : Number(raw.updatedAt) || prev?.updatedAt || now - 60_000,
      runId: raw.runId ? String(raw.runId) : working ? `omega-${id}` : undefined
    })
  }
  broadcastGatewayState()
}

function resOk(id, payload = {}) {
  return { type: 'res', id, ok: true, payload }
}

function resErr(id, code, message) {
  return { type: 'res', id, ok: false, error: { code, message } }
}

async function omegaChat(messages, model) {
  const res = await fetch(`${OMEGA_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'default',
      messages,
      stream: false,
      max_tokens: 1024
    })
  })
  if (!res.ok) throw new Error(`Omega API HTTP ${res.status}`)
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? ''
}

async function handleMethod(method, params, id) {
  switch (method) {
    case 'agents.list': {
      const agentList = [...agents.values()].map((a) => ({
        id: a.id,
        agentId: a.id,
        name: a.name,
        isDefault: a.id === AGENT_ID
      }))
      return resOk(id, {
        agents: agentList,
        defaultId: AGENT_ID,
        defaultAgentId: AGENT_ID,
        mainKey: MAIN_KEY
      })
    }
    case 'sessions.list': {
      const agentId =
        typeof params?.agentId === 'string' && agents.has(params.agentId) ? params.agentId : null
      const list = agentId
        ? [agents.get(agentId)]
        : [...agents.values()]
      return resOk(id, {
        sessions: list.filter(Boolean).map((a) => ({
          key: sessionKey(a.id),
          agentId: a.id,
          updatedAt: a.updatedAt || Date.now()
        }))
      })
    }
    case 'sessions.preview':
      return resOk(id, { previews: [] })
    case 'config.get':
      return resOk(id, {
        config: {
          agents: {
            defaults: { model: 'default' },
            list: [...agents.values()].map((a) => ({ id: a.id, model: 'default' }))
          }
        }
      })
    case 'exec.approvals.get':
      return resOk(id, { file: { agents: {} } })
    case 'agents.files.get':
      return resOk(id, { file: { missing: true } })
    case 'status':
      return resOk(id, buildStatusSnapshot())
    case 'models.list':
      return resOk(id, { models: [{ id: 'default', name: 'default' }] })
    case 'cron.list':
      return resOk(id, { jobs: [] })
    case 'skills.status':
      return resOk(id, { skills: [], workspaceDir: '' })
    case 'tasks.list':
      return resOk(id, { tasks: [] })
    case 'chat.send': {
      const message = typeof params?.message === 'string' ? params.message : ''
      const model = typeof params?.model === 'string' ? params.model : 'default'
      const agentId =
        typeof params?.agentId === 'string' && agents.has(params.agentId)
          ? params.agentId
          : 'executor'
      const a = agents.get(agentId)
      if (a) {
        a.status = 'working'
        a.updatedAt = Date.now()
        a.task = message.slice(0, 120)
        a.runId = `chat-${randomUUID()}`
        agents.set(agentId, a)
        broadcastGatewayState()
      }
      const text = await omegaChat(
        [
          { role: 'system', content: 'You are Omega, an AI assistant in a virtual office.' },
          { role: 'user', content: message }
        ],
        model
      )
      const runId = randomUUID()
      if (a) {
        a.status = 'idle'
        a.updatedAt = Date.now()
        agents.set(agentId, a)
      }
      broadcast({
        type: 'event',
        event: 'chat',
        payload: {
          runId,
          sessionKey: sessionKey(agentId),
          state: 'final',
          message: { role: 'assistant', content: text }
        }
      })
      broadcastGatewayState()
      return resOk(id, { runId, status: 'ok' })
    }
    case 'chat.history':
      return resOk(id, { messages: [] })
    default:
      return resOk(id, {})
  }
}

function startWs() {
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ingest/presence') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (Array.isArray(json.agents)) ingestAgents(json.agents)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400)
          res.end(String(e))
        }
      })
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, agents: agents.size }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Omega Claw3D adapter OK\n')
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws) => {
    let connected = false
    const sendEventFn = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    sendFns.add(sendEventFn)

    const send = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }

    send({ type: 'event', event: 'connect.challenge', payload: { nonce: randomUUID() } })

    ws.on('message', async (raw) => {
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!frame || frame.type !== 'req') return
      const { id, method, params } = frame
      if (method === 'connect') {
        const authToken =
          params && typeof params === 'object' && params.auth && typeof params.auth.token === 'string'
            ? params.auth.token.trim()
            : ''
        if (EXPECTED_GATEWAY_TOKEN && authToken && authToken !== EXPECTED_GATEWAY_TOKEN) {
          send(resErr(id, 'token_mismatch', 'Gateway token rejected'))
          return
        }
        connected = true
        const healthAgents = [...agents.values()].map((a) => ({
          id: a.id,
          agentId: a.id,
          name: a.name,
          isDefault: a.id === AGENT_ID
        }))
        send({
          type: 'res',
          id,
          ok: true,
          payload: {
            type: 'hello-ok',
            protocol: 3,
            adapterType: 'openclaw',
            features: {
              methods: [
                'agents.list',
                'sessions.list',
                'chat.send',
                'chat.history',
                'status',
                'models.list'
              ],
              events: ['chat', 'presence', 'heartbeat', 'agent']
            },
            snapshot: {
              health: { agents: healthAgents, defaultAgentId: AGENT_ID },
              sessionDefaults: { mainKey: MAIN_KEY }
            },
            auth: { role: 'operator', scopes: ['operator.admin'] },
            policy: { tickIntervalMs: 30000 }
          }
        })
        broadcastGatewayState()
        return
      }
      if (!connected) {
        send(resErr(id, 'not_connected', 'Send connect first'))
        return
      }
      try {
        send(await handleMethod(method, params, id))
      } catch (e) {
        send(resErr(id, 'internal_error', e instanceof Error ? e.message : String(e)))
      }
    })

    ws.on('close', () => sendFns.delete(sendEventFn))
  })

  httpServer.listen(ADAPTER_PORT, '127.0.0.1', () => {
    console.log(`[omega-claw3d-adapter] ws://127.0.0.1:${ADAPTER_PORT} → ${OMEGA_API_URL}`)
  })

  setInterval(() => broadcastGatewayState(), 4000)
}

startWs()
