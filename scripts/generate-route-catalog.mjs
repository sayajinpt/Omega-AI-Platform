#!/usr/bin/env node
/**
 * Generate shared route catalog from ipc.ts + engine-protocol mappings.
 * Output: apps/runtime/resources/route-catalog.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ipcPath = join(root, 'apps', 'desktop', 'src', 'shared', 'ipc.ts')
const protocolPath = join(root, 'packages', 'sdk', 'src', 'engine-protocol.ts')
const preloadPath = join(root, 'apps', 'desktop', 'src', 'shared', 'omega-api.ts')
const outPath = join(root, 'apps', 'runtime', 'resources', 'route-catalog.json')

const ipcText = readFileSync(ipcPath, 'utf8')
const protocolText = readFileSync(protocolPath, 'utf8')
const preloadText = readFileSync(preloadPath, 'utf8')

const ipcEntries = [...ipcText.matchAll(/\n\s+(\w+):\s+'(omega:[^']+)'/g)].map((m) => ({
  key: m[1],
  ipc: m[2]
}))

const ipcToEngine = {}
for (const m of protocolText.matchAll(/'(omega:[^']+)':\s+'([^']+)'/g)) {
  ipcToEngine[m[1]] = m[2]
}

const ipcKeyToChannel = Object.fromEntries(ipcEntries.map(({ key, ipc }) => [key, ipc]))
const bridgeCall = /(?:ipcRenderer|bridge)\.(invoke|send|on)\(IPC\.(\w+)/g
const preloadInvokeKeys = [...preloadText.matchAll(bridgeCall)]
  .filter((m) => m[1] === 'invoke')
  .map((m) => m[2])
const preloadSendKeys = [...preloadText.matchAll(bridgeCall)]
  .filter((m) => m[1] === 'send')
  .map((m) => m[2])
const preloadOnKeys = [...preloadText.matchAll(bridgeCall)]
  .filter((m) => m[1] === 'on')
  .map((m) => m[2])
const preloadInvokeIpcs = new Set(
  [...preloadInvokeKeys, ...preloadSendKeys].map((k) => ipcKeyToChannel[k]).filter(Boolean)
)
const preloadEventIpcs = new Set(
  [
    ...preloadOnKeys.map((k) => ipcKeyToChannel[k]).filter(Boolean),
    'omega:shortcut'
  ]
)

const NATIVE_CXX = new Set([
  'omega:config:get',
  'omega:config:set',
  'omega:runtime:status',
  'omega:system:info',
  'omega:runtime:loaded',
  'omega:models:list',
  'omega:models:load',
  'omega:models:unload',
  'omega:models:delete',
  'omega:generate',
  'omega:embed',
  'omega:engine:command',
  'omega:sessions:list',
  'omega:sessions:create',
  'omega:sessions:delete',
  'omega:sessions:messages',
  'omega:sessions:updateTitle',
  'omega:sessions:updateModel',
  'omega:sessions:fork',
  'omega:sessions:truncate',
  'omega:sessions:search',
  'omega:memory:list',
  'omega:memory:add',
  'omega:memory:delete',
  'omega:memory:search',
  'omega:memory:graph',
  'omega:memory:export',
  'omega:memory:import',
  'omega:memory:janitorRun',
  'omega:rag:list',
  'omega:rag:index-file',
  'omega:rag:index-dir',
  'omega:rag:clear',
  'omega:rag:search',
  'omega:workflows:list',
  'omega:workflows:get',
  'omega:workflows:save',
  'omega:workflows:delete',
  'omega:workflows:run',
  'omega:workflows:abort',
  'omega:skills:list',
  'omega:skills:get',
  'omega:skills:save',
  'omega:skills:delete',
  'omega:skills:toggle',
  'omega:profiles:list',
  'omega:profiles:create',
  'omega:profiles:switch',
  'omega:profiles:delete',
  'omega:soul:get',
  'omega:soul:set',
  'omega:soul:reset',
  'omega:cron:list',
  'omega:cron:save',
  'omega:cron:delete',
  'omega:cron:pause',
  'omega:cron:runNow',
  'omega:kanban:list',
  'omega:kanban:save',
  'omega:kanban:move',
  'omega:kanban:delete',
  'omega:kanban:dispatch',
  'omega:tools:list',
  'omega:tools:toggle',
  'omega:tools:run',
  'omega:tool:approve:resolve',
  'omega:capability:permission:resolve',
  'omega:chat:send',
  'omega:chat:abort',
  'omega:agent:run',
  'omega:agent:abort',
  'omega:providers:list',
  'omega:providers:save',
  'omega:providers:delete',
  'omega:providers:fetchModels',
  'omega:providers:presets',
  'omega:providers:discover',
  'omega:input-pipelines:list',
  'omega:input-pipelines:get',
  'omega:input-pipelines:save',
  'omega:input-pipelines:delete',
  'omega:input-pipelines:set-active',
  'omega:context:buffer',
  'omega:plugins:list',
  'omega:plugins:catalog',
  'omega:plugins:toggle',
  'omega:plugins:reload',
  'omega:plugins:installBuiltin',
  'omega:plugins:installUrl',
  'omega:plugins:uninstall',
  'omega:mcp:list',
  'omega:mcp:save',
  'omega:mcp:delete',
  'omega:mcp:status',
  'omega:mcp:start',
  'omega:mcp:stop',
  'omega:engines:ollama:start',
  'omega:engines:ollama:stop',
  'omega:engines:ollama:list',
  'omega:engines:ollama:pull',
  'omega:gateway:platforms',
  'omega:gateway:list',
  'omega:gateway:save',
  'omega:gateway:delete',
  'omega:gateway:start',
  'omega:gateway:stop',
  'omega:gateway:status',
  'omega:engines:status',
  'omega:inference:backends',
  'omega:inference:backend',
  'omega:inference:switch',
  'omega:engines:sidecar:status',
  'omega:content-studio:setupEnvironment',
  'omega:python:status',
  'omega:python:setup',
  'omega:project:open',
  'omega:project:list',
  'omega:pipeline:activity:get',
  'omega:debug:history',
  'omega:content-studio:status',
  'omega:content-studio:start',
  'omega:content-studio:stop',
  'omega:finetune:list',
  'omega:finetune:get',
  'omega:finetune:create',
  'omega:finetune:delete',
  'omega:finetune:start',
  'omega:finetune:abort',
  'omega:finetune:analyze',
  'omega:finetune:prepareDataset',
  'omega:finetune:listDatasets',
  'omega:finetune:listPresets',
  'omega:finetune:savePreset',
  'omega:finetune:deletePreset',
  'omega:finetune:inspectSource',
  'omega:finetune:pickSources',
  'omega:finetune:datasetsRoot',
  'omega:finetune:deletePrepared',
  'omega:model-config:get',
  'omega:model-config:reset',
  'omega:model-config:set',
  'omega:model-config:list',
  'omega:model-presets:list',
  'omega:model-presets:apply',
  'omega:model:inspect',
  'omega:model:estimate',
  'omega:model:estimateFile',
  'omega:models:footprint',
  'omega:models:benchmark',
  'omega:models:check-hf-access',
  'omega:models:repo-files',
  'omega:models:open-hf-repo',
  'omega:hf:search',
  'omega:hf:card',
  'omega:hf:tags',
  'omega:gpu:list',
  'omega:memory:projectContext',
  'omega:chat:attachment-limits',
  'omega:chat:pick-attachments',
  'omega:chat:stage-attachment',
  'omega:terminal:history',
  'omega:terminal:clear',
  'omega:terminal:runSnippet',
  'omega:terminal:saveSnippet',
  'omega:terminal:line',
  'omega:editor:read',
  'omega:editor:write',
  'omega:editor:openFiles',
  'omega:editor:saveAs',
  'omega:editor:deleteFile',
  'omega:context:find',
  'omega:context:gotoLine',
  'omega:usage:summary',
  'omega:integrations:get',
  'omega:integrations:set',
  'omega:assistant:defaultPrompt',
  'omega:self-improve:list',
  'omega:self-improve:reflect',
  'omega:self-improve:janitor',
  'omega:workforce:agents',
  'omega:workforce:runs',
  'omega:workforce:delegate',
  'omega:workforce:moa',
  'omega:workforce:standup',
  'omega:workforce:parallel',
  'omega:office:snapshot',
  'omega:office:changed',
  'omega:office:addMonitor',
  'omega:office:refreshMonitor',
  'omega:office:fetchPr',
  'omega:office:prComment',
  'omega:office:prReview',
  'omega:office:jiraComment',
  'omega:office:pollSet',
  'omega:office:pollRefreshAll',
  'omega:office:skillGym',
  'omega:office:janitor',
  'omega:office:kanbanPin',
  'omega:office:kanbanMonitor',
  'omega:office:visualization:status',
  'omega:office:visualization:setup',
  'omega:office:visualization:start',
  'omega:office:visualization:stop',
  'omega:media:state',
  'omega:media:stop',
  'omega:media:pause',
  'omega:media:resume',
  'omega:media:showPreview',
  'omega:updater:status',
  'omega:updater:check',
  'omega:updater:install',
  'omega:updater:status-event',
  'omega:content-studio:restart',
  'omega:content-studio:projects',
  'omega:content-studio:createRun',
  'omega:content-studio:runStatus',
  'omega:content-studio:forceStopJob',
  'omega:content-studio:schedules',
  'omega:content-studio:scheduleCreate',
  'omega:content-studio:scheduleDelete',
  'omega:content-studio:socialPlatforms',
  'omega:content-studio:socialAccounts',
  'omega:content-studio:socialPosts',
  'omega:content-studio:socialPublish',
  'omega:content-studio:credentialsGet',
  'omega:content-studio:credentialsSet',
  'omega:content-studio:credentialsSync',
  'omega:content-studio:credentialsStatus',
  'omega:content-studio:seriesList',
  'omega:content-studio:seriesCreate',
  'omega:content-studio:seriesDelete',
  'omega:content-studio:generationGet',
  'omega:content-studio:generationSet',
  'omega:content-studio:generationCatalog',
  'omega:content-studio:generationCapabilities',
  'omega:mcp:statusChanged',
  'omega:gateway:statusChanged',
  'omega:models:download',
  'omega:models:download-required',
  'omega:models:download:cancel',
  'omega:models:download-adapter',
  'omega:models:quantize',
  'omega:models:load-progress',
  'omega:download:progress',
  'omega:quantize:progress',
  'omega:models:inventoryChanged',
  'omega:engines:sidecar:install',
  'omega:engines:sidecar:uninstall',
  'omega:engines:sidecar:installProgress',
  'omega:config:changed',
  'omega:cron:changed',
  'omega:kanban:changed',
  'omega:providers:changed',
  'omega:runtime:status-changed',
  'omega:stream:token',
  'omega:stream:metrics',
  'omega:stream:media',
  'omega:stream:done',
  'omega:stream:error',
  'omega:pipeline:activity:changed',
  'omega:tool:approve:req',
  'omega:capability:permission:req',
  'omega:engines:ollama:pullProgress',
  'omega:finetune:progress',
  'omega:content-studio:changed',
  'omega:content-studio:setupProgress',
  'omega:session:messageAppended',
  'omega:session:assistantPatch',
  'omega:agent:step',
  'omega:agent:token',
  'omega:debug:event',
  'omega:workflows:event',
  'omega:routerModels:status',
  'omega:routerModels:installNodeRuntime',
  'omega:routerModels:setupPython',
  'omega:routerModels:build',
  'omega:routerModels:buildProgress',
  'omega:routerModels:remove',
  'omega:browser:show',
  'omega:browser:hide',
  'omega:browser:hidden',
  'omega:browser:mediaCommand',
  'omega:browser:setBounds',
  'omega:browser:navigate',
  'omega:browser:back',
  'omega:browser:forward',
  'omega:browser:reload',
  'omega:browser:status',
  'omega:browser:getStatus',
  'omega:browser:info',
  'omega:companion:set-active-chat',
  'omega:companion:get-active-chat',
  'omega:companion:send-to-main',
  'omega:companion:send-deliver',
  'omega:companion:reply-broadcast',
  'omega:companion:reply-deliver',
  'omega:avatar-monitor:set-enabled',
  'omega:avatar-monitor:get-enabled',
  'omega:avatar-monitor:enabled',
  'omega:avatar-monitor:signals',
  'omega:avatar-monitor:sync-layout',
  'omega:avatar-monitor:layout',
  'omega:avatar-monitor:set-overlay-visible',
  'omega:avatar-monitor:restore-main',
  'omega:screen-snip:capture',
  'omega:screen-snip:get-bounds',
  'omega:screen-snip:submit',
  'omega:screen-snip:cancel',
  'omega:screen-snip:save',
  'omega:screen-snip:init',
  'omega:voice:speak',
  'omega:content-studio:youtubeConnect',
  'omega:content-studio:generationDownload',
  'omega:content-studio:native:render',
  'omega:inference:media:capabilities',
  'omega:media:reopenSessionVideo'
])

const EXPLICIT_HTTP_ROUTES = {
  'omega:config:get': { method: 'GET', path: '/v1/config' },
  'omega:config:set': { method: 'PATCH', path: '/v1/config' },
  'omega:runtime:status': { method: 'GET', path: '/v1/runtime/status' },
  'omega:system:info': { method: 'GET', path: '/v1/system/info' },
  'omega:runtime:loaded': { method: 'GET', path: '/v1/models/loaded' },
  'omega:models:list': { method: 'GET', path: '/v1/models' },
  'omega:models:load': { method: 'POST', path: '/v1/models/load' },
  'omega:models:unload': { method: 'POST', path: '/v1/models/unload' },
  'omega:models:delete': { method: 'DELETE', path: '/v1/models/{modelId}' },
  'omega:engines:status': { method: 'GET', path: '/v1/engines/status' },
  'omega:inference:backends': { method: 'GET', path: '/v1/inference/backends' },
  'omega:engines:sidecar:status': { method: 'GET', path: '/v1/engines/sidecar/status' },
  'omega:content-studio:setupEnvironment': { method: 'POST', path: '/v1/python/setup' },
  'omega:python:status': { method: 'GET', path: '/v1/python/status' },
  'omega:python:setup': { method: 'POST', path: '/v1/python/setup' },
  /** Publish path is POST; do not infer GET from action name "signals". */
  'omega:avatar-monitor:signals': { method: 'POST', path: '/v1/avatar-monitor/signals' },
  'omega:inference:media:capabilities': { method: 'GET', path: '/v1/inference/media/capabilities' },
  'omega:inference:media:image': { method: 'POST', path: '/v1/inference/media/image' },
  'omega:inference:media:tts': { method: 'POST', path: '/v1/inference/media/tts' },
  'omega:content-studio:native:render': { method: 'POST', path: '/v1/content-studio/native/render' },
  'omega:content-studio:generationCatalog': {
    method: 'GET',
    path: '/v1/content-studio/generationCatalog'
  },
  'omega:content-studio:generationCapabilities': {
    method: 'GET',
    path: '/v1/content-studio/generationCapabilities'
  },
  /** Runtime route is POST with JSON body { id }; do not infer DELETE from action name. */
  'omega:sessions:delete': { method: 'POST', path: '/v1/sessions/delete' },
  'omega:input-pipelines:delete': { method: 'POST', path: '/v1/input-pipelines/delete' }
}

function inferDomain(ipc) {
  const seg = ipc.replace(/^omega:/, '').split(':')[0]
  if (seg.includes('content-studio')) return 'content_studio'
  if (seg.includes('finetune')) return 'finetune'
  if (seg.includes('browser')) return 'browser'
  if (seg.includes('media')) return 'media'
  if (seg.includes('office') || seg.includes('workforce')) return 'office'
  if (seg.includes('session') || seg.includes('chat') || seg.includes('stream') || seg.includes('agent'))
    return 'chat'
  if (seg.includes('memory') || seg.includes('context') || seg.includes('rag')) return 'memory'
  if (seg.includes('model') || seg.includes('inference') || seg.includes('engine') || seg.includes('gpu'))
    return 'models'
  if (seg.includes('plugin')) return 'plugins'
  if (seg.includes('workflow')) return 'workflows'
  if (seg.includes('python') || seg.includes('sidecar') || seg.includes('routerModels'))
    return 'python'
  if (ipc.endsWith('Changed') || ipc.endsWith('Event') || seg.includes('Progress')) return 'events'
  return 'other'
}

function inferTarget(domain, ipc) {
  if (ipcToEngine[ipc]) return 'cxx'
  if (domain === 'content_studio' || domain === 'finetune' || domain === 'python') return 'python'
  if (domain === 'events') return 'ws'
  if (domain === 'browser' || domain === 'media') return 'cxx'
  return 'cxx'
}

function inferPhase(ipc, engineCommand) {
  if (NATIVE_CXX.has(ipc) || engineCommand) return 2
  const d = inferDomain(ipc)
  if (d === 'events') return 5
  if (d === 'browser' || d === 'media') return 5
  if (d === 'content_studio' || d === 'finetune') return 6
  if (d === 'chat' || d === 'memory') return 3
  if (d === 'models') return 2
  return 4
}

function statusFor(ipc, engineCommand) {
  if (NATIVE_CXX.has(ipc)) return 'native'
  if (EXPLICIT_HTTP_ROUTES[ipc]) return 'native'
  if (engineCommand) return 'engine_bridge'
  if (inferDomain(ipc) === 'events') return 'websocket'
  return 'electron'
}

function inferHttpMethod(action) {
  if (/Catalog$/i.test(action)) return 'GET'
  if (/^(list|get|status|history|snapshot|loaded|channels|info|presets|tags|card|search|graph|buffer|platforms|catalog|root|inspect|estimate|footprint|benchmark|files|defaults|prompt|enabled|signals|layout|bounds|active|platforms|backends|backend|devices|activity|summary|agents|runs|projects|schedules|accounts|posts|series|datasets|presets|workflows|pipelines|sources|plugins|skills|profiles|soul|cron|kanban|tasks|providers|gateways|mcp|decisions|memory|integrations|visualization|inventory|credentials|generation|catalog|changed|credentialsGet|credentialsStatus|generationGet)$/i.test(action))
    return 'GET'
  if (/^(delete|remove|abort|stop|clear|cancel|uninstall|force|reset)$/i.test(action)) return 'DELETE'
  if (/^(set|update|save|patch|toggle|move|pause|switch|sync|truncate|fork|rename|resolve|pin|poll|comment|review|publish|connect|apply|write|stage|hide|show|navigate|reload|back|forward|dispatch|delegate|standup|parallel|moa|reflect|janitor|install|start|setup|build|pull|download|quantize|index|open|create|save|run|send|speak|capture|submit|init|restore|deliver|broadcast|pick|prepare|analyze|inspect|upload|forceStop|scheduleCreate|scheduleDelete|seriesCreate|seriesDelete|generationSet|credentialsSet|credentialsSync|youtubeConnect|socialPublish|kanbanPin|kanbanMonitor|addMonitor|refreshMonitor|fetchPr|prComment|prReview|jiraComment|pollRefreshAll|skillGym|janitor|visualizationSetup|visualizationStart|visualizationStop|setupEnvironment|setupPython|installNodeRuntime|routerModelsBuild|routerModelsRemove|sidecarInstall|sidecarUninstall|ollamaStart|ollamaStop|ollamaPull|mcpStart|mcpStop|gatewayStart|gatewayStop|cronRunNow|profilesSwitch|profilesCreate|profilesDelete|skillsToggle|skillsDelete|pluginsToggle|pluginsReload|pluginsInstall|workflowsRun|workflowsAbort|finetuneStart|finetuneAbort|finetuneDelete|contentStudioStart|contentStudioStop|contentStudioRestart|contentStudioCreateRun|contentStudioForceStopJob|modelsLoad|modelsUnload|modelsDelete|modelsDownload|modelsQuantize|chatSend|chatAbort|agentRun|agentAbort|toolApprove|capabilityPermission|memoryAdd|memoryDelete|memoryExport|memoryImport|memoryJanitorRun|sessionsCreate|sessionsDelete|sessionsUpdateTitle|sessionsFork|sessionsTruncate|terminalRunSnippet|terminalSaveSnippet|editorWrite|editorSaveAs|editorDeleteFile|updaterCheck|updaterInstall)$/i.test(action))
    return 'POST'
  return 'POST'
}

function inferHttpPath(ipc) {
  if (EXPLICIT_HTTP_ROUTES[ipc]) return EXPLICIT_HTTP_ROUTES[ipc]
  const rest = ipc.replace(/^omega:/, '')
  const parts = rest.split(':')
  const action = parts[parts.length - 1]
  const domainParts = parts.slice(0, -1)
  const method = inferHttpMethod(action)
  const path = `/v1/${domainParts.join('/')}/${action}`
  return { method, path }
}

const routes = ipcEntries.map(({ key, ipc }) => {
  const engineCommand = ipcToEngine[ipc] ?? null
  const http = inferHttpPath(ipc)
  const domain = inferDomain(ipc)
  return {
    key,
    ipc,
    domain,
    target: inferTarget(domain, ipc),
    phase: inferPhase(ipc, engineCommand),
    status: statusFor(ipc, engineCommand),
    engine_command: engineCommand,
    http: engineCommand
      ? { method: http.method, path: http.path, engine: engineCommand }
      : http,
    ws: inferDomain(ipc) === 'events' ? `/v1/events${ipc.replace(/^omega:/, '').replace(/:/g, '/')}` : null
  }
})

routes.unshift(
  {
    key: 'healthz',
    ipc: null,
    domain: 'runtime',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'GET', path: '/healthz' },
    ws: null
  },
  {
    key: 'runtimeInfo',
    ipc: null,
    domain: 'runtime',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'GET', path: '/v1/runtime/info' },
    ws: null
  },
  {
    key: 'runtimeRoutes',
    ipc: null,
    domain: 'runtime',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'GET', path: '/v1/runtime/routes' },
    ws: null
  },
  {
    key: 'engineCommand',
    ipc: 'omega:engine:command',
    domain: 'models',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'POST', path: '/v1/engine/command' },
    ws: null
  },
  {
    key: 'inferenceMediaCapabilities',
    ipc: 'omega:inference:media:capabilities',
    domain: 'models',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'GET', path: '/v1/inference/media/capabilities' },
    ws: null
  },
  {
    key: 'inferenceMediaImage',
    ipc: 'omega:inference:media:image',
    domain: 'models',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'POST', path: '/v1/inference/media/image' },
    ws: null
  },
  {
    key: 'inferenceMediaTts',
    ipc: 'omega:inference:media:tts',
    domain: 'models',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'POST', path: '/v1/inference/media/tts' },
    ws: null
  },
  {
    key: 'contentStudioNativeRender',
    ipc: 'omega:content-studio:native:render',
    domain: 'content_studio',
    target: 'cxx',
    phase: 2,
    status: 'native',
    engine_command: null,
    http: { method: 'POST', path: '/v1/content-studio/native/render' },
    ws: null
  }
)

const summary = {
  total: routes.length,
  native: routes.filter((r) => r.status === 'native').length,
  engine_bridge: routes.filter((r) => r.status === 'engine_bridge').length,
  electron: routes.filter((r) => r.status === 'electron').length,
  websocket: routes.filter((r) => r.status === 'websocket').length,
  by_target: {
    cxx: routes.filter((r) => r.target === 'cxx').length,
    python: routes.filter((r) => r.target === 'python').length,
    ws: routes.filter((r) => r.target === 'ws').length
  }
}

const catalog = {
  version: 1,
  generated_at: new Date().toISOString(),
  summary,
  routes
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(catalog, null, 2))
console.log(`[route-catalog] ${outPath} (${summary.total} routes, ${summary.native} native C++)`)

const ipcHttpOut = join(root, 'packages', 'sdk', 'src', 'ipc-http-map.generated.ts')
const invokeRoutes = routes.filter((r) => r.ipc && r.http && preloadInvokeIpcs.has(r.ipc))
const eventIpcs = [...preloadEventIpcs].sort()
const ipcHttpMap = Object.fromEntries(
  invokeRoutes.map((r) => [r.ipc, { method: r.http.method, path: r.http.path }])
)
const ipcHttpTs = `/** Generated by scripts/generate-route-catalog.mjs — do not edit. */
export const IPC_HTTP_MAP = ${JSON.stringify(ipcHttpMap, null, 2)} as const

export type IpcHttpChannel = keyof typeof IPC_HTTP_MAP

export const IPC_EVENT_CHANNELS: readonly string[] = ${JSON.stringify(eventIpcs, null, 2)}

export function isIpcHttpChannel(ipc: string): ipc is IpcHttpChannel {
  return ipc in IPC_HTTP_MAP
}
`
mkdirSync(dirname(ipcHttpOut), { recursive: true })
writeFileSync(ipcHttpOut, ipcHttpTs)
console.log(`[route-catalog] ${ipcHttpOut} (${invokeRoutes.length} invoke routes, ${eventIpcs.length} event channels)`)
