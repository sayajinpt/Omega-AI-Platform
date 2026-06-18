import { useCallback, useEffect, useState } from 'react'
import type { AgentStep, MemoryEntry, MediaRef, ModelInfo, OmegaConfig } from '@omega/sdk'
import { applyThemeFromConfig } from './lib/apply-theme'
import { engineClient } from './lib/engine'
import { BRAND_NAME } from '../../shared/brand'
import { ResizablePanel } from './components/ResizablePanel'
import { Sidebar } from './components/Sidebar'
import { loadLayoutPrefs, saveLayoutPrefs } from './lib/layout-prefs'
import { Onboarding } from './components/Onboarding'
import { ToolApprovalModal } from './components/ToolApprovalModal'
import { ChatPage } from './pages/ChatPage'
import { ModelsPage } from './pages/ModelsPage'
import { InstalledModelsPage } from './pages/InstalledModelsPage'
import { AgentPage } from './pages/AgentPage'
import { MemoryPage } from './pages/MemoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { DebugPage } from './pages/DebugPage'
import { ToolsPage } from './pages/ToolsPage'
import { WorkflowsPage } from './pages/WorkflowsPage'
import { DocsPage } from './pages/DocsPage'
import { SkillsPage } from './pages/SkillsPage'
import { SoulPage } from './pages/SoulPage'
import { SchedulesPage } from './pages/SchedulesPage'
import { KanbanPage } from './pages/KanbanPage'
import { McpPage } from './pages/McpPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { EnginesPage } from './pages/EnginesPage'
import { GatewayPage } from './pages/GatewayPage'
import { PluginStorePage } from './pages/PluginStorePage'
import { BrowserPage } from './pages/BrowserPage'
import { OMEGA_BROWSER_OPEN, type OmegaBrowserOpenDetail } from './lib/open-omega-browser'
import { FinetunePage } from './pages/FinetunePage'
import { ContentStudioPage } from './pages/ContentStudioPage'
import { TextEditorPage } from './pages/TextEditorPage'
import { OfficePage } from './pages/OfficePage'
import { ButtonClickFeedback } from './components/ButtonClickFeedback'
import { FloatingAvatar, type AvatarSignals } from './components/Avatar3D'
import { CompanionTopBar } from './components/CompanionTopBar'
import { MediaPlayerBar } from './components/MediaPlayerBar'
import {
  effectiveAvatarSignalState,
  isChatStreamActive,
  onAvatarInferenceMetrics,
  onAvatarStreamEnd,
  onAvatarStreamStart,
  onAvatarStreamToken
} from './lib/avatar-stream-viz'
import { speakText } from './lib/voice-assistant'
import { isVoiceOutputEnabled, speakAssistantReply } from './lib/voice-reply'
import { useCompanionMonitor } from './lib/use-companion-monitor'
import { deliverCompanionToChat } from './lib/companion-chat'
import { useDownloadQueue } from './lib/useDownloadQueue'
import { handleContextFind, handleContextGotoLine } from './lib/context-menu-bridge'

export type Page =
  | 'chat'
  | 'models'
  | 'installed-models'
  | 'agent'
  | 'workflows'
  | 'kanban'
  | 'schedules'
  | 'memory'
  | 'docs'
  | 'skills'
  | 'soul'
  | 'tools'
  | 'mcp'
  | 'providers'
  | 'engines'
  | 'gateway'
  | 'plugins'
  | 'browser'
  | 'text-editor'
  | 'finetune'
  | 'content-studio'
  | 'office'
  | 'settings'
  | 'debug'

const NAV_LAYOUT_KEY = 'omega.nav.layout'

export default function App() {
  const [page, setPage] = useState<Page>('chat')
  const [navLayout, setNavLayout] = useState(() => loadLayoutPrefs(NAV_LAYOUT_KEY, 0, 224))
  const [config, setConfig] = useState<OmegaConfig | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [runtimeState, setRuntimeState] = useState('starting')
  const [activeModel, setActiveModel] = useState<string>('')
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [avatarSignals, setAvatarSignals] = useState<AvatarSignals>({
    state: 'idle',
    speaking: 0,
    listening: 0
  })
  const {
    avatarMonitorOn,
    companionVisible,
    toggleMonitor: handleAvatarMonitorToggle,
    onCompanionVisibleChange,
    pushOverlaySignals,
    hideInWindowCompanion
  } = useCompanionMonitor()
  const [downloadJobs, setDownloadJobs] = useDownloadQueue()
  const [browserPendingUrl, setBrowserPendingUrl] = useState<string | null>(null)

  const log = useCallback((line: string) => {
    setDebugLog((prev) => [`[${new Date().toLocaleTimeString()}] ${line}`, ...prev].slice(0, 500))
  }, [])

  useEffect(() => {
    return engineClient.voice.onSpeak(({ text, mode }) => {
      void engineClient.config.get().then((cfg) => {
        if (!isVoiceOutputEnabled(cfg.omegaTools)) return
        if (mode === 'browser' || mode.startsWith('browser')) {
          speakText(text)
          return
        }
        void speakAssistantReply(text, cfg.omegaTools)
      })
    })
  }, [])

  useEffect(() => {
    const handler = (ev: Event): void => {
      const url = (ev as CustomEvent<OmegaBrowserOpenDetail>).detail?.url
      if (!url?.trim()) return
      setPage('browser')
      setBrowserPendingUrl(url.trim())
    }
    window.addEventListener(OMEGA_BROWSER_OPEN, handler)
    return () => window.removeEventListener(OMEGA_BROWSER_OPEN, handler)
  }, [])

  /** Leaving chat hides in-chat media; tear down embedded browser except on the Browser page. */
  useEffect(() => {
    if (page === 'chat') return
    void engineClient.media.stop().catch(() => {})
    if (page !== 'browser') {
      void engineClient.browser.hide()
    }
  }, [page])

  /** Tear down stray embedded browser hosts except while the Browser tab is active. */
  useEffect(() => {
    if (!config?.onboardingComplete) return
    if (page === 'browser') return
    void engineClient.browser.hide()
  }, [config?.onboardingComplete, page])

  useEffect(() => {
    if (!config) return
    return applyThemeFromConfig(config)
  }, [config])

  const refresh = useCallback(async () => {
    const cfg = await engineClient.config.get()
    setConfig(cfg)
    const status = await engineClient.runtime.status()
    setRuntimeState(status.state)
    setActiveModel(status.activeModel ?? '')
    if (status.error) log(`runtime: ${status.error}`)
    const modelRows = await engineClient.models.list()
    setModels(Array.isArray(modelRows) ? modelRows : [])
    const memoryRows = await engineClient.memory.list()
    setMemory(Array.isArray(memoryRows) ? memoryRows : [])
  }, [log])

  useEffect(() => {
    return engineClient.config.onChanged((cfg) => {
      if (cfg && typeof cfg === 'object' && 'onboardingComplete' in cfg) {
        setConfig(cfg as OmegaConfig)
        return
      }
      void engineClient.config.get().then(setConfig)
    })
  }, [])

  useEffect(() => {
    const off = engineClient.models.onInventoryChanged(() => {
      void refresh()
    })
    const offCs = engineClient.contentStudio.onChanged(() => {
      void refresh()
    })
    return () => {
      off()
      offCs()
    }
  }, [refresh])

  useEffect(() => {
    const goEditor = () => setPage('text-editor')
    window.addEventListener('omega:navigate-editor', goEditor)
    return () => window.removeEventListener('omega:navigate-editor', goEditor)
  }, [])

  useEffect(() => {
    const offFind = engineClient.onContextFind(() => handleContextFind())
    const offGoto = engineClient.onContextGotoLine(() => handleContextGotoLine())
    return () => {
      offFind()
      offGoto()
    }
  }, [])

  useEffect(() => {
    const onCfg = (e: Event) => {
      const detail = (e as CustomEvent<OmegaConfig>).detail
      if (detail) setConfig(detail)
    }
    window.addEventListener('omega-config-changed', onCfg)
    return () => window.removeEventListener('omega-config-changed', onCfg)
  }, [])

  useEffect(() => {
    pushOverlaySignals(avatarSignals)
  }, [avatarSignals, pushOverlaySignals])

  useEffect(() => {
    refresh()
    const offRuntime = engineClient.runtime.onStatusChanged((s) => {
      setRuntimeState(s.state ?? 'ready')
      const err = (s as { engine_error?: string }).engine_error
      if (err) {
        setActiveModel('')
        log(`runtime engine: ${err}`)
        return
      }
      setActiveModel(s.activeModel ?? '')
    })
    const offProviders = engineClient.providers.onChanged(() => {
      void refresh()
    })
    const offStep = engineClient.agent.onStep((step) => {
      const normalized: AgentStep = {
        ...step,
        title: step.title || (step as AgentStep & { label?: string }).label || step.kind
      }
      setAgentSteps((prev) => {
        const idx = prev.findIndex((s) => s.id === normalized.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = normalized
          return next
        }
        return [...prev, normalized]
      })
      log(`agent ${normalized.kind}: ${normalized.title}`)
    })
    const offDbg = engineClient.debug.onEvent((e) => {
      if (e.level !== 'token') log(`[${e.source}] ${e.message}`)
    })
    let chatVizActive = false
    const finishChatViz = (): void => {
      chatVizActive = false
      onAvatarStreamEnd()
      setAvatarSignals((s) => ({ ...s, state: 'idle', speaking: 0, listening: 0 }))
      setAgentSteps([])
    }
    // Drive avatar from chat token stream (only while a chat send is in flight)
    const offToken = engineClient.chat.onToken(({ token }) => {
      if (!chatVizActive || !isChatStreamActive()) return
      onAvatarStreamToken(token.text)
      setAvatarSignals((s) => {
        if (!isChatStreamActive()) return s
        return { ...s, state: 'speaking', speaking: Math.min(1, s.speaking + 0.2) }
      })
    })
    const offMetrics = engineClient.chat.onMetrics(({ metrics }) => {
      if (!chatVizActive || !isChatStreamActive()) return
      onAvatarInferenceMetrics(metrics)
      if (metrics.phase === 'idle' || metrics.phase === 'prefill') {
        setAvatarSignals((s) => {
          if (!isChatStreamActive()) return { ...s, state: 'idle', speaking: 0 }
          if (metrics.phase === 'idle') return { ...s, state: 'idle', speaking: 0 }
          return { ...s, state: 'thinking', speaking: 0 }
        })
      }
    })
    const offMedia = engineClient.media.onState((state) => {
      if (state.kind === 'idle') return
      setAvatarSignals((s) => ({ ...s, state: 'idle', speaking: 0 }))
    })
    const offDone = engineClient.chat.onDone(() => {
      finishChatViz()
    })
    const offErr = engineClient.chat.onError(() => {
      chatVizActive = false
      onAvatarStreamEnd()
      setAvatarSignals((s) => ({ ...s, state: 'error', speaking: 0 }))
      setAgentSteps([])
      window.dispatchEvent(new CustomEvent('omega:streaming-end'))
    })
    const onStreamStart = (): void => {
      chatVizActive = true
      onAvatarStreamStart()
      setAvatarSignals((s) => ({ ...s, state: 'thinking', speaking: 0 }))
    }
    const onStreamEnd = (): void => {
      finishChatViz()
    }
    const onListening = (e: Event): void => {
      const level = (e as CustomEvent<number>).detail ?? 0
      setAvatarSignals((s) => ({
        ...s,
        listening: level,
        state: level > 0 && s.state === 'idle' ? 'idle' : s.state
      }))
    }
    const onVoiceSpeaking = (e: Event): void => {
      const active = Boolean((e as CustomEvent<boolean>).detail)
      setAvatarSignals((s) => ({
        ...s,
        state: active ? 'speaking' : isChatStreamActive() ? s.state : 'idle',
        speaking: active ? 1 : 0
      }))
    }
    window.addEventListener('omega:streaming-start', onStreamStart)
    window.addEventListener('omega:streaming-end', onStreamEnd)
    window.addEventListener('omega:avatar-listening', onListening)
    window.addEventListener('omega:voice-speaking', onVoiceSpeaking)
    const decay = setInterval(
      () => setAvatarSignals((s) => ({ ...s, speaking: Math.max(0, s.speaking - 0.05) })),
      100
    )
    return () => {
      offRuntime()
      offProviders()
      offStep()
      offDbg()
      offToken()
      offMetrics()
      offMedia()
      offDone()
      offErr()
      window.removeEventListener('omega:streaming-start', onStreamStart)
      window.removeEventListener('omega:streaming-end', onStreamEnd)
      window.removeEventListener('omega:avatar-listening', onListening)
      window.removeEventListener('omega:voice-speaking', onVoiceSpeaking)
      clearInterval(decay)
    }
  }, [refresh, log])

  useEffect(() => {
    return engineClient.companion.onSendDeliver((detail) => {
      setPage('chat')
      window.dispatchEvent(new CustomEvent('omega:focus-chat'))
      deliverCompanionToChat(detail)
    })
  }, [])

  useEffect(() => {
    const off = engineClient.shortcuts.on(({ action, page: target }) => {
      switch (action) {
        case 'new-chat':
          window.dispatchEvent(new CustomEvent('omega:new-chat'))
          setPage('chat')
          break
        case 'clear-chat':
          window.dispatchEvent(new CustomEvent('omega:clear-chat'))
          break
        case 'open-settings':
          setPage('settings')
          break
        case 'find':
          window.dispatchEvent(new CustomEvent('omega:find'))
          setPage('chat')
          break
        case 'fork-chat':
          window.dispatchEvent(new CustomEvent('omega:fork-chat'))
          setPage('chat')
          break
        case 'delete-chat':
          window.dispatchEvent(new CustomEvent('omega:delete-chat'))
          setPage('chat')
          break
        case 'edit-message':
          window.dispatchEvent(new CustomEvent('omega:edit-message'))
          setPage('chat')
          break
        case 'nav':
          if (target) setPage(target as Page)
          break
        default:
          break
      }
    })
    const keyHandler = (ev: KeyboardEvent): void => {
      const mod = ev.ctrlKey || ev.metaKey
      const tag = (ev.target as HTMLElement | null)?.tagName
      if (mod && ev.shiftKey && ev.key.toLowerCase() === 'b') {
        ev.preventDefault()
        setPage('browser')
        return
      }
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target as HTMLElement | null)?.isContentEditable
      // Esc cancels an in-flight stream (works everywhere)
      if (ev.key === 'Escape' && !inField) {
        window.dispatchEvent(new CustomEvent('omega:cancel'))
      }
      // Ctrl+K — focus the chat input from anywhere
      if (mod && ev.key.toLowerCase() === 'k') {
        ev.preventDefault()
        window.dispatchEvent(new CustomEvent('omega:focus-chat'))
        setPage('chat')
      }
    }
    window.addEventListener('keydown', keyHandler)
    return () => {
      off()
      window.removeEventListener('keydown', keyHandler)
    }
  }, [])

  if (!config) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        Starting {BRAND_NAME}…
      </div>
    )
  }

  if (!config.onboardingComplete) {
    return (
      <>
      <ButtonClickFeedback />
      <Onboarding
        config={config}
        onDone={(c) => {
          setConfig(c)
          refresh()
        }}
      />
      </>
    )
  }

  return (
    <>
    <ButtonClickFeedback />
    <div className="omega-app-shell flex h-screen flex-col overflow-hidden bg-zinc-950">
      <div className="relative z-[80] shrink-0">
        <CompanionTopBar
          avatarEnabled={config.avatarEnabled !== false}
          companionVisible={companionVisible}
          detached={avatarMonitorOn}
          signals={{
            ...avatarSignals,
            state: effectiveAvatarSignalState(avatarSignals.state)
          }}
          onCompanionVisibleChange={onCompanionVisibleChange}
          onDetachToggle={handleAvatarMonitorToggle}
        />
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <ResizablePanel
        side="left"
        width={navLayout.navWidth}
        hidden={navLayout.navHidden}
        minWidth={180}
        maxWidth={360}
        onWidthChange={(navWidth) =>
          setNavLayout((prev) => {
            const next = { ...prev, navWidth }
            saveLayoutPrefs(NAV_LAYOUT_KEY, next)
            return next
          })
        }
        onHiddenChange={(navHidden) =>
          setNavLayout((prev) => {
            const next = { ...prev, navHidden }
            saveLayoutPrefs(NAV_LAYOUT_KEY, next)
            return next
          })
        }
      >
        <Sidebar page={page} onNavigate={setPage} runtimeState={runtimeState} activeModel={activeModel} />
      </ResizablePanel>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className={page === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <ChatPage
            config={config}
            models={models}
            agentSteps={agentSteps}
            onClearAgentSteps={() => setAgentSteps([])}
            onLog={log}
            onRefresh={refresh}
            onOpenModels={() => setPage('installed-models')}
            onNavigate={setPage}
            chatActive={page === 'chat'}
          />
        </div>
        {page === 'models' && (
          <ModelsPage
            models={models}
            config={config}
            onRefresh={refresh}
            downloadJobs={downloadJobs}
            setDownloadJobs={setDownloadJobs}
            onOpenSettings={() => setPage('settings')}
          />
        )}
        {page === 'installed-models' && (
          <InstalledModelsPage
            models={models}
            config={config}
            onRefresh={refresh}
            onOpenModelStudio={() => setPage('models')}
          />
        )}
        {page === 'agent' && (
          <AgentPage
            config={config}
            models={models}
            steps={agentSteps}
            onClearSteps={() => setAgentSteps([])}
            onLog={log}
          />
        )}
        {page === 'workflows' && <WorkflowsPage config={config} models={models} onLog={log} />}
        {page === 'kanban' && <KanbanPage models={models} />}
        {page === 'schedules' && <SchedulesPage models={models} />}
        {page === 'memory' && <MemoryPage entries={memory} onRefresh={refresh} />}
        {page === 'docs' && <DocsPage />}
        {page === 'skills' && <SkillsPage />}
        {page === 'soul' && <SoulPage />}
        {page === 'tools' && <ToolsPage />}
        {page === 'mcp' && <McpPage />}
        {page === 'providers' && <ProvidersPage />}
        {page === 'engines' && <EnginesPage />}
        {page === 'gateway' && <GatewayPage models={models} onNavigate={setPage} />}
        {page === 'plugins' && <PluginStorePage />}
        <div className={page === 'browser' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <BrowserPage
            active={page === 'browser'}
            pendingUrl={browserPendingUrl}
            onPendingUrlConsumed={() => setBrowserPendingUrl(null)}
          />
        </div>
        {page === 'text-editor' && <TextEditorPage />}
        {page === 'finetune' && <FinetunePage config={config} models={models} />}
        {config.allowContentStudio !== false && (
          <div className={page === 'content-studio' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <ContentStudioPage config={config} active={page === 'content-studio'} />
          </div>
        )}
        {page === 'office' && (
          <OfficePage
            agentSteps={agentSteps}
            onClearAgentSteps={() => setAgentSteps([])}
            onOpenAgent={() => setPage('agent')}
          />
        )}
        {page === 'settings' && (
          <SettingsPage
            config={config}
            models={models}
            onSaved={(c) => {
              setConfig(c)
              refresh()
            }}
          />
        )}
        {page === 'debug' && <DebugPage log={debugLog} runtimeState={runtimeState} />}
      </main>
      <ToolApprovalModal />
      <MediaPlayerBar />
      </div>
    </div>
    {config.avatarEnabled !== false && !avatarMonitorOn && companionVisible && (
      <FloatingAvatar
        signals={{
          ...avatarSignals,
          state: effectiveAvatarSignalState(avatarSignals.state)
        }}
        monitorEnabled={avatarMonitorOn}
        onMonitorToggle={handleAvatarMonitorToggle}
        onRequestHide={hideInWindowCompanion}
      />
    )}
    </>
  )
}
