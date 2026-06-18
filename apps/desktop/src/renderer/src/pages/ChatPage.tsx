import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { AgentStep, MediaRef, Message, ModelInfo, OmegaConfig } from '@omega/sdk'
import { AgentErrorBanner } from '../components/AgentErrorBanner'
import { AgentStepStrip } from '../components/AgentStepStrip'
import { ProjectKnowledgePanel } from '../components/ProjectKnowledgePanel'
import { SlashHelpModal } from '../components/SlashHelpModal'
import { formatAgentError } from '../lib/agent-errors'
import { ChatComposer, type ChatComposerHandle } from '../components/ChatComposer'
import { ChatMessageRow } from '../components/ChatMessageRow'
import { OmegaTerminalPanel } from '../components/OmegaTerminalPanel'
import { resolveEnableThinkingForModel } from '../lib/resolve-enable-thinking'
import { useThrottledStreamPatch } from '../lib/use-throttled-stream-patch'
import { replaceCodeFenceInMessage } from '../lib/parse-markdown-segments'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { EditMessageModal } from '../components/EditMessageModal'
import { ModelLoadProgressBar } from '../components/ModelLoadProgressBar'
import { ResizablePanel } from '../components/ResizablePanel'
import { clearChatDraft, loadChatDraft, saveChatDraft } from '../lib/chat-draft'
import {
  isLocalModelId,
  isProviderQualifiedModelId,
  modelIdsMatch,
  normalizeModelId
} from '../lib/model-id'
import { loadLayoutPrefs, saveLayoutPrefs } from '../lib/layout-prefs'
import { engineClient, refreshRuntimeSnapshot, useModelLoad } from '../lib/engine'
import { previewContentStudioJobInChat, previewSessionMediaInChat } from '../lib/media-controls'
import { runSlashCommand } from '../lib/slash-commands'
import { isVoiceInputEnabled, speakAssistantReply } from '../lib/voice-reply'
import { DEFAULT_OMEGA_SYSTEM_PROMPT } from '../../../shared/assistant-prompt'
import { buildAssistantMessageParts, resetAgentStreamState } from '../../../shared/assistant-choices'
import {
  dedupeMessageParts,
  dedupeContentStudioParts,
  mergeAssistantPatchParts,
  upsertContentStudioPart
} from '../../../shared/message-parts'
import { publishActiveChat } from '../lib/active-chat-bridge'
import { COMPANION_TO_CHAT_EVENT, type CompanionToChatDetail } from '../lib/companion-chat'
import { resolveActiveChatSessionId, resolveCompanionModel } from '../lib/companion-chat'
import { MEDIA_STOP_REQUEST_EVENT } from '../lib/media-controls'
import { fetchMediaPlayerState } from '../lib/fetch-media-state'
import { publishContextTokens } from '../lib/context-tokens-bridge'
import {
  clearCompanionStream,
  isCompanionStream,
  markCompanionStream,
  publishCompanionReply
} from '../lib/companion-reply-bridge'

function contentStudioJobPlayable(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded'
}

function directVideoJobPlayable(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'completed' || s === 'succeeded'
}

function assistantPartMatchesJob(
  part: NonNullable<Message['parts']>[number],
  jobId: string
): boolean {
  if (part.type === 'content_studio' && part.jobId === jobId) return true
  if (part.type === 'direct_video' && part.jobId === jobId) return true
  return false
}

function pushStreamMediaPart(parts: Message['parts'], part: NonNullable<Message['parts']>[number]): void {
  if (part.type === 'content_studio') {
    const merged = upsertContentStudioPart(parts ?? [], part)
    parts!.length = 0
    parts!.push(...merged)
    return
  }
  parts!.push(part)
}
import { ChatMediaReviewPanel } from '../components/ChatMediaReviewPanel'
import { ChatExtensionApproval } from '../components/ChatExtensionApproval'
import { ChatCapabilityApproval } from '../components/ChatCapabilityApproval'
import { ChatToolApproval } from '../components/ChatToolApproval'
import { deriveSessionTitle } from '../../../shared/chat-session-title'

const CHAT_LAYOUT_KEY = 'omega.chat.layout'

function uuid(): string {
  return crypto.randomUUID()
}

interface SessionRow {
  id: string
  title: string
  modelId: string
  updatedAt: number
}

function isModelLoaded(loaded: string[], modelId: string): boolean {
  return loaded.some((id) => modelIdsMatch(id, modelId))
}

/** Reset UI if chat IPC never completes (engine crash / hang). */
function armChatStreamWatchdog(onStall: () => void, ms = 600_000): () => void {
  const id = window.setTimeout(onStall, ms)
  return () => window.clearTimeout(id)
}

function lastUserMessageIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') return i
  }
  return -1
}

/** Normalize assistant rows from SQLite (choices parts, etc.). */
function normalizeSessionMessages(rows: Message[]): Message[] {
  return rows.map((r) => {
    const m = { ...r, role: r.role as Message['role'] }
    if (m.parts?.length) {
      const deduped = dedupeMessageParts(m.parts)
      if (deduped.length !== m.parts.length) {
        return { ...m, parts: deduped }
      }
    }
    if (m.role !== 'assistant') return m
    const built = buildAssistantMessageParts(m.content, m.parts ?? [])
    return {
      ...m,
      content: built.content,
      parts: built.parts ?? m.parts,
      reasoningContent: built.reasoningContent,
      reasoningOpen: built.reasoningOpen ?? undefined
    }
  })
}

/** Keep a streamed assistant bubble when SQLite is missing or stale vs the live UI. */
function mergeSessionRowsWithLocalUi(prev: Message[], normalized: Message[]): Message[] {
  if (!normalized.length) return prev.length ? prev : normalized
  if (!prev.length) return normalized

  const prevLast = prev[prev.length - 1]
  if (prevLast?.role !== 'assistant') return normalized

  const prevVisible = Boolean(prevLast.content?.trim() || prevLast.parts?.length)
  if (!prevVisible) return normalized

  const normLast = normalized[normalized.length - 1]
  if (normLast?.role !== 'assistant') {
    return [...normalized, prevLast]
  }

  const normVisible = Boolean(normLast.content?.trim() || normLast.parts?.length)
  if (!normVisible) {
    const copy = [...normalized]
    copy[copy.length - 1] = prevLast
    return copy
  }

  const prevRichness =
    (prevLast.content?.length ?? 0) + (prevLast.parts?.length ?? 0) * 64
  const normRichness =
    (normLast.content?.length ?? 0) + (normLast.parts?.length ?? 0) * 64
  if (prevRichness > normRichness) {
    const copy = [...normalized]
    copy[copy.length - 1] = {
      ...normLast,
      content: prevLast.content || normLast.content,
      parts: prevLast.parts?.length ? prevLast.parts : normLast.parts,
      reasoningContent: prevLast.reasoningContent ?? normLast.reasoningContent,
      reasoningOpen: prevLast.reasoningOpen ?? normLast.reasoningOpen
    }
    return copy
  }

  return normalized
}

function normalizeAssistantRow(m: Message): Message {
  if (m.role !== 'assistant') return m
  const built = buildAssistantMessageParts(m.content, m.parts ?? [])
  return {
    ...m,
    content: built.content,
    parts: built.parts ?? m.parts,
    reasoningContent: built.reasoningContent,
    reasoningOpen: built.reasoningOpen
  }
}

function mergeAssistantRows(prev: Message, incoming: Message): Message {
  const mergedParts = mergeAssistantPatchParts(prev.parts, incoming.parts ?? [])
  const built = buildAssistantMessageParts(incoming.content || prev.content || '', mergedParts)
  return {
    ...prev,
    ...incoming,
    content: built.content || incoming.content || prev.content,
    parts: built.parts ?? mergedParts,
    reasoningContent: built.reasoningContent ?? prev.reasoningContent,
    reasoningOpen: built.reasoningOpen ?? prev.reasoningOpen
  }
}

function youtubeQueryFromUserMessage(text: string): string {
  const trimmed = text.trim()
  const playMatch = trimmed.match(
    /(?:^play\s+)(.+?)(?:\s+from\s+youtube|\s+on\s+youtube|\s+in\s+youtube)?$/i
  )
  if (playMatch?.[1]) return playMatch[1].trim()
  return trimmed
    .replace(/\s+(from|on|in)\s+youtube.*$/i, '')
    .replace(/^play\s+/i, '')
    .trim()
}

function messageClaimsYoutubePlayback(content: string): boolean {
  return /playing on youtube|opened youtube|youtube in the chat media player/i.test(content)
}

function messageHasYoutubePart(m: Message): boolean {
  return m.parts?.some((p) => p.type === 'youtube') ?? false
}

export function ChatPage({
  config,
  models,
  agentSteps = [],
  onClearAgentSteps,
  onLog,
  onRefresh,
  onOpenModels,
  onNavigate,
  chatActive = true
}: {
  config: OmegaConfig
  models: ModelInfo[]
  agentSteps?: AgentStep[]
  onClearAgentSteps?: () => void
  onLog: (s: string) => void
  onRefresh: () => void
  /** Opens the Models sidebar tab (installed / load). */
  onOpenModels?: () => void
  onNavigate?: (page: import('../App').Page) => void
  /** False when another main tab is selected (chat panel hidden). */
  chatActive?: boolean
}) {
  const savedDraft = loadChatDraft()
  const [layout, setLayout] = useState(() => loadLayoutPrefs(CHAT_LAYOUT_KEY, 240))
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [sessionId, setSessionId] = useState<string | null>(savedDraft.sessionId ?? null)
  const [messages, setMessages] = useState<Message[]>([])
  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const userScrolledUpRef = useRef(false)
  const messageVirtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null)
  const [input, setInput] = useState(savedDraft.input ?? '')
  const [streaming, setStreaming] = useState(false)
  const streamingRef = useRef(false)
  streamingRef.current = streaming
  const [modelId, setModelId] = useState(
    savedDraft.modelId || config.defaultModel || models[0]?.id || ''
  )
  const modelIdRef = useRef(modelId)
  modelIdRef.current = modelId
  const [systemPrompt, setSystemPrompt] = useState(
    config.systemPrompt?.trim() || DEFAULT_OMEGA_SYSTEM_PROMPT
  )
  const [assistantPreviewOpen, setAssistantPreviewOpen] = useState(false)
  const [fullAssistantPrompt, setFullAssistantPrompt] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')
  const [ctxInfo, setCtxInfo] = useState('')
  const [agentMode, setAgentMode] = useState(savedDraft.agentMode ?? true)
  const voiceInputEnabled = isVoiceInputEnabled(config.omegaTools)
  const assistantModelId =
    config.omegaTools?.assistantModelId?.trim() || config.defaultModel || ''
  const [chatError, setChatError] = useState<string | null>(null)
  const [slashHelpOpen, setSlashHelpOpen] = useState(false)
  const [loadedModels, setLoadedModels] = useState<string[]>([])
  const [activeModel, setActiveModel] = useState('')
  const {
    load: runModelLoad,
    unload: runModelUnload,
    busy: modelLoadBusy,
    percent: modelLoadPercent,
    status: modelLoadStatus,
    setStatus: setModelLoadStatus,
    setPercent: setModelLoadPercent
  } = useModelLoad({
    onRefresh,
    onError: setChatError,
    autoClearStatusMs: 4000
  })
  const modelLoadBusyRef = useRef(false)
  modelLoadBusyRef.current = modelLoadBusy
  const chatErrorHint = useMemo(
    () => (chatError ? formatAgentError(chatError, modelLoadBusy ? 'model' : 'chat') : null),
    [chatError, modelLoadBusy]
  )
  const [sessionSearch, setSessionSearch] = useState('')
  const [editTarget, setEditTarget] = useState<{ index: number; content: string } | null>(null)
  const [selectedMsgIndex, setSelectedMsgIndex] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const useVirtualMessages = messages.length >= 48 && !streaming
  const messageVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messagesScrollRef.current,
    estimateSize: () => 140,
    overscan: 5,
    getItemKey: (index) => `${sessionId ?? 'new'}-${index}`,
    enabled: useVirtualMessages
  })
  messageVirtualizerRef.current = messageVirtualizer

  const lastMediaRevealKeyRef = useRef<string | null>(null)
  const embedMediaActiveRef = useRef(false)
  const youtubeRecoveryRef = useRef<string | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const sessionSearchRef = useRef<HTMLInputElement>(null)
  const restoredSessionRef = useRef(false)
  const [overlayEpoch, setOverlayEpoch] = useState(0)
  const prevSessionIdRef = useRef<string | null>(sessionId)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const inlineYoutubeInChat = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'assistant') continue
      if (messageHasYoutubePart(m)) return true
      break
    }
    return false
  }, [messages])

  const chatModels = models.filter((m) => m.remote || m.id.startsWith('ollama:') || (m.path && isLocalModelId(m.id)))
  const selectedModel = useMemo(
    () => chatModels.find((m) => modelIdsMatch(m.id, modelId)) ?? models.find((m) => modelIdsMatch(m.id, modelId)),
    [chatModels, models, modelId]
  )
  const isRemoteModel = Boolean(selectedModel?.remote)
  const canLoadUnload =
    Boolean(modelId) && !isRemoteModel && isLocalModelId(modelId) && !modelId.startsWith('ollama:')
  const modelInMemory = isRemoteModel
    ? Boolean(modelId && modelIdsMatch(activeModel, modelId))
    : modelId
      ? isModelLoaded(loadedModels, modelId) || modelIdsMatch(activeModel, modelId)
      : false

  const refreshRuntime = useCallback(async () => {
    const snap = await refreshRuntimeSnapshot()
    setBackend(snap.backend ?? '')
    setActiveModel(snap.activeModel)
    setLoadedModels(snap.loadedModels)
  }, [])


  const loadSessions = useCallback(async (): Promise<SessionRow[]> => {
    const q = sessionSearch.trim()
    const list = (
      q.length >= 2
        ? await engineClient.sessions.search(q)
        : await engineClient.sessions.list()
    ) as SessionRow[]
    setSessions(list)
    return list
  }, [sessionSearch])

  useEffect(() => {
    loadSessions()
    void refreshRuntime()
    const tick = () => {
      if (document.visibilityState === 'visible') void refreshRuntime()
    }
    const t = setInterval(tick, 10_000)
    const offRuntime = engineClient.runtime.onStatusChanged((s) => {
      setRuntimeState(s.state ?? 'ready')
      const err = (s as { engine_error?: string }).engine_error
      if (err) {
        setActiveModel('')
        return
      }
      setActiveModel(s.activeModel ?? '')
      if (Array.isArray((s as { loadedModels?: string[] }).loadedModels)) {
        setLoadedModels((s as { loadedModels: string[] }).loadedModels)
      } else {
        void engineClient.runtime.loadedModels().then(setLoadedModels).catch(() => setLoadedModels([]))
      }
    })
    const offPipeline = engineClient.pipeline.onChanged(() => {
      void refreshRuntime()
    })
    const offCs = engineClient.contentStudio.onChanged(() => {
      void refreshRuntime()
    })
    return () => {
      clearInterval(t)
      offRuntime()
      offPipeline()
      offCs()
    }
  }, [loadSessions, refreshRuntime])

  useEffect(() => {
    if (restoredSessionRef.current || sessions.length === 0) return
    if (streamingRef.current) {
      restoredSessionRef.current = true
      return
    }
    const draftSid = loadChatDraft().sessionId
    if (!draftSid) {
      restoredSessionRef.current = true
      return
    }
    if (!sessions.some((s) => s.id === draftSid)) {
      restoredSessionRef.current = true
      clearChatDraft()
      return
    }
    restoredSessionRef.current = true
    void selectSession(draftSid)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore draft session once
  }, [sessions])

  useEffect(() => {
    const pool = chatModels.length > 0 ? chatModels : models
    if (pool.length === 0) return
    setModelId((cur) => {
      if (cur && pool.some((m) => modelIdsMatch(m.id, cur))) return normalizeModelId(cur)
      const def = config.defaultModel
      if (def && pool.some((m) => modelIdsMatch(m.id, def))) return normalizeModelId(def)
      return normalizeModelId(pool[0]!.id)
    })
  }, [models, chatModels, config.defaultModel])

  const mediaPanelRef = useRef<HTMLDivElement>(null)

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth', force = false) => {
      if (!force && userScrolledUpRef.current) return
      const el = messagesScrollRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
      userScrolledUpRef.current = false
      setShowScrollToBottom(false)
    },
    []
  )

  const onStreamFlush = useCallback(() => {
    if (useVirtualMessages) {
      messageVirtualizerRef.current?.measure()
      if (!userScrolledUpRef.current) {
        const n = messageVirtualizerRef.current?.options.count ?? 0
        if (n > 0) {
          messageVirtualizerRef.current?.scrollToIndex(n - 1, { align: 'end' })
        }
      }
    } else {
      scrollMessagesToBottom('auto')
    }
  }, [scrollMessagesToBottom, useVirtualMessages])

  const streamPatch = useThrottledStreamPatch(setMessages, { onFlush: onStreamFlush })

  const lastMessageFingerprint =
    messages.length > 0
      ? `${messages[messages.length - 1]?.role}:${(messages[messages.length - 1]?.content ?? '').length}`
      : ''

  useEffect(() => {
    if (!messages.length) return
    if (!streaming && userScrolledUpRef.current) return
    if (useVirtualMessages) {
      messageVirtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    } else {
      scrollMessagesToBottom(streaming ? 'auto' : 'smooth')
    }
  }, [
    messages.length,
    lastMessageFingerprint,
    streaming,
    useVirtualMessages,
    messageVirtualizer,
    scrollMessagesToBottom
  ])

  /**
   * Scroll to show new media once. Does not fight the user after they scroll away.
   * @param opts.force — scroll even when the user has scrolled up (rare; prefer onceKey)
   * @param opts.key — dedupe: only auto-scroll once per media identity
   */
  const scrollToRevealMedia = useCallback(
    (opts?: boolean | { force?: boolean; key?: string }) => {
      const parsed = typeof opts === 'boolean' ? { force: opts } : (opts ?? {})
      const force = parsed.force ?? false
      const key = parsed.key?.trim()
      if (key && lastMediaRevealKeyRef.current === key) return
      if (!force && userScrolledUpRef.current) return
      if (key) lastMediaRevealKeyRef.current = key
      requestAnimationFrame(() => {
        scrollMessagesToBottom('auto', force)
      })
    },
    [scrollMessagesToBottom]
  )

  const handleMediaPanelVisible = useCallback(
    (key: string) => {
      scrollToRevealMedia({ key })
    },
    [scrollToRevealMedia]
  )

  const onMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const scrolledUp = distanceFromBottom > 96
    userScrolledUpRef.current = scrolledUp
    setShowScrollToBottom(scrolledUp)
  }, [])

  const pruneEmptyAssistantOnError = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && !last.content.trim() && !last.parts?.length) {
        return prev.slice(0, -1)
      }
      return prev
    })
  }, [])

  useEffect(() => {
    if (!chatActive) {
      void engineClient.media.stop().catch(() => {})
      void engineClient.browser.hide()
      return
    }
    return engineClient.media.onState((s) => {
      const embedBrowser =
        s.embedInChat !== false &&
        (s.kind === 'youtube' || (s.kind === 'preview' && s.previewType === 'web'))
      if (s.kind === 'idle' || !embedBrowser) {
        void engineClient.browser.hide()
      }
      const embedInChat = s.embedInChat !== false
      const showInPanel =
        embedInChat &&
        (s.kind === 'youtube' ||
          (s.kind === 'preview' &&
            s.previewType !== 'file' &&
            s.previewType !== 'web'))
      if (showInPanel && !embedMediaActiveRef.current) {
        embedMediaActiveRef.current = true
        const key = [s.kind, s.sessionId, s.mediaRef, s.url].filter(Boolean).join('|')
        scrollToRevealMedia({ key })
      }
      if (s.kind === 'idle') {
        embedMediaActiveRef.current = false
        lastMediaRevealKeyRef.current = null
      }
    })
  }, [chatActive, scrollToRevealMedia])

  /** Model sometimes claims YouTube playback without running play_youtube — recover once per turn. */
  useEffect(() => {
    if (streaming || !chatActive) return
    const last = messages[messages.length - 1]
    const prev = messages[messages.length - 2]
    if (last?.role !== 'assistant' || prev?.role !== 'user') return
    if (messageHasYoutubePart(last)) return
    if (!/youtube/i.test(prev.content) && !/\bplay\b/i.test(prev.content)) return
    if (!messageClaimsYoutubePlayback(last.content ?? '')) return
    const query = youtubeQueryFromUserMessage(prev.content)
    if (!query) return
    const key = `${sessionId ?? 'new'}:${query.toLowerCase()}`
    if (youtubeRecoveryRef.current === key) return
    youtubeRecoveryRef.current = key
    void (async () => {
      const state = await fetchMediaPlayerState()
      if (state?.kind === 'youtube') return
      if (messageHasYoutubePart(last)) return
      try {
        await engineClient.tools.run('play_youtube', { query })
      } catch {
        /* ignore — user can retry or open Browser tab */
      }
    })()
  }, [streaming, messages, chatActive, sessionId])

  useEffect(() => {
    const level = input.trim().length > 0 ? Math.min(1, input.length / 80) : 0
    window.dispatchEvent(new CustomEvent('omega:avatar-listening', { detail: level }))
  }, [input])

  useEffect(() => {
    saveChatDraft({ input, sessionId, modelId, agentMode })
  }, [input, sessionId, modelId, agentMode])

  useEffect(() => {
    publishActiveChat({ sessionId, modelId, systemPrompt })
  }, [sessionId, modelId, systemPrompt])

  useEffect(() => {
    return engineClient.chat.onSessionMessage((p) => {
      if (!p.sessionId || p.sessionId !== sessionIdRef.current) return
      const incoming = normalizeAssistantRow(p.message)
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        const prevUser = prev[prev.length - 2]
        if (
          incoming.role === 'user' &&
          last?.role === 'assistant' &&
          !String(last.content ?? '').trim() &&
          !(last.parts?.length ?? 0) &&
          prevUser?.role === 'user' &&
          prevUser.content === incoming.content
        ) {
          return prev
        }
        if (incoming.role === 'assistant' && last?.role === 'assistant') {
          return [...prev.slice(0, -1), mergeAssistantRows(last, incoming)]
        }
        if (
          incoming.role === 'assistant' &&
          last?.role === 'user'
        ) {
          return [...prev, incoming]
        }
        if (last?.role === incoming.role && last.content === incoming.content) {
          return prev
        }
        return [...prev, incoming]
      })
      scrollToRevealMedia()
    })
  }, [sessionId, scrollToRevealMedia])

  useEffect(() => {
    return engineClient.chat.onSessionAssistantPatch((p) => {
      if (!p.sessionId || p.sessionId !== sessionIdRef.current) return
      setMessages((prev) => {
        const copy = [...prev]
        const jobId = p.jobId?.trim()
        const applyPatch = (index: number) => {
          const row = copy[index]
          if (row?.role !== 'assistant') return false
          const mergedParts = mergeAssistantPatchParts(row.parts, p.parts ?? [])
          const patchText = p.content ?? ''
          const built = buildAssistantMessageParts(
            patchText || row.content || '',
            mergedParts
          )
          copy[index] = {
            role: 'assistant',
            content: built.content,
            parts: built.parts,
            reasoningContent: built.reasoningContent,
            reasoningOpen: built.reasoningOpen
          }
          return true
        }
        if (typeof p.messageIndex === 'number' && p.messageIndex >= 0 && p.messageIndex < copy.length) {
          if (applyPatch(p.messageIndex)) return copy
        }
        if (jobId) {
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i]?.role !== 'assistant') continue
            const hasJob = copy[i]!.parts?.some((x) => assistantPartMatchesJob(x, jobId))
            if (!hasJob) continue
            if (applyPatch(i)) return copy
          }
        }
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i]?.role !== 'assistant') continue
          if (applyPatch(i)) return copy
        }
        const mergedParts = mergeAssistantPatchParts(undefined, p.parts ?? [])
        const built = buildAssistantMessageParts(p.content ?? '', mergedParts)
        if (built.content.trim() || built.parts?.length) {
          return [
            ...copy,
            {
              role: 'assistant' as const,
              content: built.content,
              parts: built.parts,
              reasoningContent: built.reasoningContent,
              reasoningOpen: built.reasoningOpen
            }
          ]
        }
        return prev
      })
      const cs = p.parts.find((x) => x.type === 'content_studio')
      const directVideo = p.parts.find((x) => x.type === 'direct_video')
      const video = p.parts.find((x) => x.type === 'video')
      if (cs && cs.type === 'content_studio' && contentStudioJobPlayable(cs.status)) {
        scrollToRevealMedia({ key: `cs:${cs.jobId}` })
        previewContentStudioJobInChat(p.sessionId, cs.projectId, cs.jobId, cs.title)
      } else if (
        directVideo &&
        directVideo.type === 'direct_video' &&
        directVideoJobPlayable(directVideo.status) &&
        directVideo.videoRef
      ) {
        scrollToRevealMedia({ key: `direct-video:${directVideo.jobId}` })
        previewSessionMediaInChat(p.sessionId, { type: 'video', ref: directVideo.videoRef })
      } else if (video && video.type === 'video') {
        scrollToRevealMedia({ key: `video:${video.ref}` })
        previewSessionMediaInChat(p.sessionId, video)
      }
      if (video && video.type === 'video') {
        void engineClient.media.showPreview(p.sessionId, video).catch(() => {})
      }
    })
  }, [sessionId, scrollToRevealMedia])

  const refreshContextTokens = useCallback(async () => {
    const mid = normalizeModelId(modelId)
    if (!sessionId || !mid) {
      publishContextTokens({ sessionId: null, tokenEstimate: 0, maxContext: 0, messageCount: 0 })
      setCtxInfo('')
      return
    }
    try {
      const buf = await engineClient.sessions.contextBuffer(sessionId, mid)
      const label = `${buf.tokenEstimate.toLocaleString()} / ${buf.maxContext.toLocaleString()} tokens`
      setCtxInfo(label)
      publishContextTokens({
        sessionId,
        tokenEstimate: buf.tokenEstimate,
        maxContext: buf.maxContext,
        messageCount: buf.messageCount
      })
    } catch {
      setCtxInfo('')
    }
  }, [sessionId, modelId])

  useEffect(() => {
    void refreshContextTokens()
  }, [refreshContextTokens, messages.length])

  useEffect(() => {
    if (!streaming) return
    void refreshContextTokens()
    const t = setInterval(() => void refreshContextTokens(), 8000)
    return () => clearInterval(t)
  }, [streaming, refreshContextTokens])

  const persistLayout = useCallback(
    (patch: Partial<typeof layout>) => {
      setLayout((prev) => {
        const next = { ...prev, ...patch }
        saveLayoutPrefs(CHAT_LAYOUT_KEY, next)
        return next
      })
    },
    []
  )

  useEffect(() => {
    const t = setTimeout(() => {
      void loadSessions()
    }, sessionSearch.trim().length >= 2 ? 250 : 0)
    return () => clearTimeout(t)
  }, [sessionSearch, loadSessions])

  const filteredSessions = sessions

  const composerRef = useRef<ChatComposerHandle>(null)
  const currentStreamRef = useRef<string | null>(null)

  const loadModelIntoMemory = useCallback(
    async (id: string): Promise<void> => {
      setChatError(null)
      const norm = normalizeModelId(id)
      const remote = Boolean(chatModels.find((m) => modelIdsMatch(m.id, norm))?.remote)
      await runModelLoad(id, { isRemote: remote })
    },
    [chatModels, runModelLoad]
  )

  const unloadModelFromMemory = useCallback(async (): Promise<void> => {
    if (!modelId) return
    setChatError(null)
    try {
      await runModelUnload(modelId)
    } catch {
      /* useModelLoad onError */
    }
  }, [modelId, runModelUnload])

  const syncSessionModelId = useCallback(
    async (sid: string, mid: string): Promise<void> => {
      const norm = normalizeModelId(mid)
      if (!sid || !norm) return
      try {
        await engineClient.sessions.updateModel(sid, norm)
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, modelId: norm } : s))
        )
      } catch {
        /* non-fatal */
      }
    },
    []
  )

  /** Local chat uses one GGUF at a time — match dropdown before send/regenerate. */
  const activateChatModelForSend = useCallback(
    async (mid: string): Promise<void> => {
      const norm = normalizeModelId(mid)
      const remote = Boolean(chatModels.find((m) => modelIdsMatch(m.id, norm))?.remote)
      const isOllama = norm.startsWith('ollama:')
      if (!norm || remote || isOllama || !isLocalModelId(norm)) return

      const snap = await refreshRuntimeSnapshot()
      const loaded = snap.loadedModels ?? []
      for (const id of loaded) {
        if (!modelIdsMatch(id, norm)) {
          await engineClient.models.unload(id).catch(() => {})
        }
      }
      if (snap.activeModel && !modelIdsMatch(snap.activeModel, norm)) {
        await engineClient.models.unload(snap.activeModel).catch(() => {})
      }

      const after = await refreshRuntimeSnapshot()
      const inMemory =
        modelIdsMatch(after.activeModel, norm) ||
        (after.loadedModels ?? []).some((id) => modelIdsMatch(id, norm))
      if (!inMemory) {
        await runModelLoad(norm, { isRemote: false })
      } else {
        await refreshRuntime()
      }
    },
    [chatModels, runModelLoad, refreshRuntime]
  )

  const prepareChatSend = useCallback(
    async (sid: string | null, mid: string): Promise<string | null> => {
      const norm = normalizeModelId(mid)
      if (!norm) return null
      if (sid) await syncSessionModelId(sid, norm)
      await activateChatModelForSend(norm)
      return norm
    },
    [syncSessionModelId, activateChatModelForSend]
  )

  const syncMessagesFromSession = useCallback(async (id: string): Promise<void> => {
    const rows = (await engineClient.sessions.messages(id)) as Message[]
    const normalized = normalizeSessionMessages(rows)
    setMessages((prev) => mergeSessionRowsWithLocalUi(prev, normalized))
  }, [])

  /** Agent mode may suppress streamed tokens; apply the final IPC result immediately. */
  const applyFinalAssistantResult = useCallback((text: string, parts?: Message['parts']) => {
    setMessages((prev) => {
      if (!prev.length) return prev
      const last = prev[prev.length - 1]
      if (last?.role !== 'assistant') return prev
      const mergedParts = parts?.length
        ? mergeAssistantPatchParts(last.parts, parts)
        : last.parts
      const built = buildAssistantMessageParts(text || last.content || '', mergedParts ?? [])
      if (!built.content.trim() && !built.parts?.length) return prev
      const copy = [...prev]
      copy[copy.length - 1] = {
        role: 'assistant',
        content: built.content,
        parts: built.parts,
        reasoningContent: built.reasoningContent ?? last.reasoningContent,
        reasoningOpen: built.reasoningOpen ?? last.reasoningOpen
      }
      return copy
    })
  }, [])

  const selectSession = async (id: string) => {
    lastMediaRevealKeyRef.current = null
    embedMediaActiveRef.current = false
    userScrolledUpRef.current = false
    setSessionId(id)
    setSelectedMsgIndex(null)
    setEditTarget(null)
    await syncMessagesFromSession(id)
    const all = (await engineClient.sessions.list()) as SessionRow[]
    const s = all.find((x) => x.id === id) ?? sessions.find((x) => x.id === id)
    if (s?.modelId) {
      setModelId(normalizeModelId(s.modelId))
      const buf = await engineClient.sessions.contextBuffer(id, s.modelId)
      setCtxInfo(`${buf.tokenEstimate.toLocaleString()} / ${buf.maxContext.toLocaleString()} tokens`)
      publishContextTokens({
        sessionId: id,
        tokenEstimate: buf.tokenEstimate,
        maxContext: buf.maxContext,
        messageCount: buf.messageCount
      })
    }
  }

  const updateMessageChoices = useCallback(
    (messageIndex: number, patch: { status: 'answered' | 'dismissed'; selectedValue?: string }) => {
      setMessages((prev) => {
        const m = prev[messageIndex]
        if (!m?.parts?.some((p) => p.type === 'choices')) return prev
        const copy = [...prev]
        copy[messageIndex] = {
          ...m,
          parts: m.parts!.map((p) =>
            p.type === 'choices'
              ? { ...p, status: patch.status, selectedValue: patch.selectedValue }
              : p
          )
        }
        return copy
      })
    },
    []
  )

  const updateBriefingChoicePicks = useCallback(
    (
      messageIndex: number,
      picks: Array<{ partIndex: number; value: string }>,
      opts?: { dismissRest?: boolean }
    ) => {
      setMessages((prev) => {
        const m = prev[messageIndex]
        if (!m?.parts?.length) return prev
        const picked = new Map(picks.map((p) => [p.partIndex, p.value]))
        const copy = [...prev]
        copy[messageIndex] = {
          ...m,
          parts: m.parts.map((p, pi) => {
            if (p.type !== 'choices') return p
            const value = picked.get(pi)
            if (value) return { ...p, status: 'answered' as const, selectedValue: value }
            if (opts?.dismissRest) return { ...p, status: 'dismissed' as const }
            return p
          })
        }
        return copy
      })
    },
    []
  )

  const dismissAllMessageChoices = useCallback((messageIndex: number) => {
    setMessages((prev) => {
      const m = prev[messageIndex]
      if (!m?.parts?.length) return prev
      const copy = [...prev]
      copy[messageIndex] = {
        ...m,
        parts: m.parts.map((p) =>
          p.type === 'choices' ? { ...p, status: 'dismissed' as const } : p
        )
      }
      return copy
    })
  }, [])

  const handleCodeBlockEdit = useCallback((messageIndex: number, codeIndex: number, newCode: string, lang: string) => {
    setMessages((prev) => {
      const m = prev[messageIndex]
      if (!m) return prev
      const content = replaceCodeFenceInMessage(m.content, codeIndex, newCode, lang)
      const copy = [...prev]
      copy[messageIndex] = { ...m, content, parts: [{ type: 'text', text: content }] }
      return copy
    })
  }, [])

  const renderMessageRow = (i: number) => {
    const m = messages[i]!
    const choiceParts = m.parts?.filter((p) => p.type === 'choices') ?? []
    return (
      <ChatMessageRow
        message={m}
        index={i}
        sessionId={sessionId}
        streaming={streaming}
        isActiveStream={streaming && i === messages.length - 1 && m.role === 'assistant'}
        selected={selectedMsgIndex === i}
        showRegenerate={m.role === 'assistant' && i > 0 && messages[i - 1]?.role === 'user'}
        onSelectUser={() => setSelectedMsgIndex(i)}
        onOpenEdit={() => openEditModal(i)}
        onRegenerate={() => void regenerateAt(i)}
        onNavigateContentStudio={onNavigate ? () => onNavigate('content-studio') : undefined}
        onOpenBrowser={onNavigate ? () => onNavigate('browser') : undefined}
        onCodeBlockEdit={(codeIndex, newCode, lang) => handleCodeBlockEdit(i, codeIndex, newCode, lang)}
        onChoiceSend={
          m.role === 'assistant' && m.parts?.some((p) => p.type === 'choices')
            ? (value) => {
                updateMessageChoices(i, { status: 'answered', selectedValue: value })
                const gpuMsg =
                  value === 'max_performance' || value === 'keep_agent'
                    ? `GPU mode: ${value}`
                    : value
                void send([], gpuMsg)
              }
            : undefined
        }
        onChoiceDismiss={
          m.role === 'assistant' && m.parts?.some((p) => p.type === 'choices')
            ? () => updateMessageChoices(i, { status: 'dismissed' })
            : undefined
        }
        onChoiceFillComposer={
          m.role === 'assistant'
            ? (value) => {
                setInput(value)
                restoreComposerFocus()
              }
            : undefined
        }
        onChoiceBundleSubmit={
          m.role === 'assistant' && choiceParts.length >= 2
            ? (combined, picks, opts) => {
                const omegaChoosesRest =
                  opts?.omegaChoosesRest || picks.some((p) => /defaults|you decide/i.test(p.value))
                const pendingChoiceCount = choiceParts.filter(
                  (p) => (p.status ?? 'pending') === 'pending'
                ).length
                updateBriefingChoicePicks(i, picks, {
                  dismissRest: omegaChoosesRest || picks.length < pendingChoiceCount
                })
                void send([], combined)
              }
            : undefined
        }
        onChoiceBundleDismiss={
          m.role === 'assistant' && choiceParts.length >= 2
            ? () => dismissAllMessageChoices(i)
            : undefined
        }
      />
    )
  }

  const bumpOverlayEpoch = useCallback((): void => {
    lastMediaRevealKeyRef.current = null
    embedMediaActiveRef.current = false
    setOverlayEpoch((n) => n + 1)
  }, [])

  const dismissChatOverlays = useCallback(async (): Promise<void> => {
    bumpOverlayEpoch()
    document.body.style.userSelect = ''
    await engineClient.media.stop().catch(() => {})
    await engineClient.browser.hide().catch(() => {})
  }, [bumpOverlayEpoch])

  const releaseComposerLocks = useCallback((): void => {
    const streamId = currentStreamRef.current
    if (streamId) {
      void engineClient.chat.abort(streamId).catch(() => {})
      currentStreamRef.current = null
    }
    setStreaming(false)
    setModelLoadStatus(null)
    setModelLoadPercent(0)
    setEditTarget(null)
    setSlashHelpOpen(false)
    document.body.style.userSelect = ''
    void dismissChatOverlays()
    window.dispatchEvent(new CustomEvent('omega:streaming-end'))
  }, [dismissChatOverlays])

  /** BrowserView / companion stacking can block composer clicks — restore focus and unlock styles. */
  const restoreComposerFocus = useCallback((opts?: { skipHide?: boolean }): void => {
    document.body.style.userSelect = ''
    document.body.style.pointerEvents = ''
    const focus = (): void => {
      window.dispatchEvent(new CustomEvent('omega:focus-chat'))
      composerRef.current?.focus()
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(focus)
    })
    window.setTimeout(focus, 80)
    window.setTimeout(focus, 200)
    if (opts?.skipHide) return
    void engineClient.browser.hide()
  }, [])

  const ensureComposerInteractive = useCallback((): void => {
    setStreaming(false)
    setModelLoadStatus(null)
    setModelLoadPercent(0)
    restoreComposerFocus({ skipHide: true })
  }, [restoreComposerFocus])

  /** BrowserView detach races session switches — retry hide + focus (companion-independent). */
  const scheduleComposerRecovery = useCallback((): void => {
    ensureComposerInteractive()
    for (const ms of [0, 50, 150, 400]) {
      window.setTimeout(() => {
        void engineClient.browser.hide().catch(() => {})
        ensureComposerInteractive()
      }, ms)
    }
  }, [ensureComposerInteractive])

  useEffect(() => {
    const prev = prevSessionIdRef.current
    prevSessionIdRef.current = sessionId
    // First session attach (null → id) happens on the opening send — keep in-chat media.
    if (prev === null && sessionId !== null) return
    if (prev === sessionId) return
    bumpOverlayEpoch()
    void engineClient.browser.hide()
  }, [sessionId, bumpOverlayEpoch])

  useEffect(() => {
    return engineClient.browser.onHidden(() => {
      restoreComposerFocus({ skipHide: true })
    })
  }, [restoreComposerFocus])

  useEffect(() => {
    const onMediaStop = (): void => {
      if (streamingRef.current) releaseComposerLocks()
    }
    window.addEventListener(MEDIA_STOP_REQUEST_EVENT, onMediaStop)
    return () => window.removeEventListener(MEDIA_STOP_REQUEST_EVENT, onMediaStop)
  }, [releaseComposerLocks])

  /** Clear the composer without creating a DB row until the user sends a message. */
  const clearChatView = useCallback(async (): Promise<void> => {
    await dismissChatOverlays()
    releaseComposerLocks()
    setMessages([])
    setInput('')
    setCtxInfo('')
    setChatError(null)
    setSelectedMsgIndex(null)
    setSessionId(null)
    publishContextTokens({ sessionId: null, tokenEstimate: 0, maxContext: 0, messageCount: 0 })
    clearChatDraft()
    restoredSessionRef.current = true
    ensureComposerInteractive()
  }, [dismissChatOverlays, releaseComposerLocks, ensureComposerInteractive])

  const resetChat = (): void => {
    void clearChatView()
  }

  const newSession = (): void => {
    void clearChatView()
  }

  const focusComposer = useCallback((): void => {
    void engineClient.browser.hide()
    window.dispatchEvent(new CustomEvent('omega:focus-chat'))
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [])

  const executeDeleteSession = async (id: string): Promise<void> => {
    const wasActive = sessionId === id
    await dismissChatOverlays()
    releaseComposerLocks()
    setEditTarget(null)
    setSelectedMsgIndex(null)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    try {
      await engineClient.sessions.delete(id)
      const draft = loadChatDraft()
      if (draft.sessionId === id) clearChatDraft()
      const list = await loadSessions()
      if (wasActive) {
        setMessages([])
        setInput('')
        setCtxInfo('')
        publishContextTokens({ sessionId: null, tokenEstimate: 0, maxContext: 0, messageCount: 0 })
        if (list.length > 0) {
          await selectSession(list[0]!.id)
        } else {
          await clearChatView()
        }
      }
    } catch (e) {
      await loadSessions()
      setChatError(e instanceof Error ? e.message : String(e))
    } finally {
      scheduleComposerRecovery()
    }
  }

  const requestDeleteSession = (id: string): void => {
    setDeleteConfirmId(id)
  }

  const forkSession = async (id: string): Promise<void> => {
    try {
      const forked = await engineClient.sessions.fork(id)
      await loadSessions()
      await selectSession(forked.id)
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e))
    }
  }

  const openEditModal = (messageIndex: number): void => {
    const msg = messages[messageIndex]
    if (!msg || msg.role !== 'user' || streaming || !sessionId) return
    setEditTarget({ index: messageIndex, content: msg.content })
  }

  const submitEditMessage = async (text: string): Promise<void> => {
    if (!editTarget || !sessionId || streaming) return
    const { index } = editTarget
    const trimmed = text.trim()
    if (!trimmed) return
    setEditTarget(null)
    try {
      await engineClient.sessions.truncate(sessionId, index)
      const kept = messages.slice(0, index)
      setMessages(kept)
      setChatError(null)
      await sendWithMessages(trimmed, kept)
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e))
    }
  }

  const forkCurrentSession = async (): Promise<void> => {
    const id = sessionId ?? filteredSessions[0]?.id
    if (!id) return
    await forkSession(id)
  }

  const deleteCurrentSession = (): void => {
    const id = sessionId ?? filteredSessions[0]?.id
    if (!id) return
    requestDeleteSession(id)
  }

  const editMessageShortcut = (): void => {
    if (editTarget || streaming) return
    let idx = selectedMsgIndex
    if (idx === null || messages[idx]?.role !== 'user') {
      idx = lastUserMessageIndex(messages)
    }
    if (idx >= 0) openEditModal(idx)
  }

  /** Regenerate assistant reply after the user message at index-1. */
  const regenerateAt = async (assistantIndex: number): Promise<void> => {
    const userIdx = assistantIndex - 1
    if (userIdx < 0 || messages[userIdx]?.role !== 'user' || !sessionId) return
    const userContent = messages[userIdx]!.content
    try {
      await engineClient.sessions.truncate(sessionId, userIdx)
      const kept = messages.slice(0, userIdx)
      setMessages(kept)
      setChatError(null)
      setInput(userContent)
      await sendWithMessages(userContent, kept)
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e))
    }
  }

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId
    const normModel = normalizeModelId(modelId)
    if (!normModel) return null
    try {
      const title = deriveSessionTitle(input) || 'New chat'
      const s = (await engineClient.sessions.create(title, normModel, systemPrompt)) as { id: string }
      setSessionId(s.id)
      await loadSessions()
      return s.id
    } catch {
      return null
    }
  }, [sessionId, modelId, systemPrompt, input, loadSessions])

  const buildUserMsg = (text: string, attachments: MediaRef[]): Message => {
    const trimmed = text.trim()
    const parts: Message['parts'] = []
    if (trimmed) parts.push({ type: 'text', text: trimmed })
    for (const a of attachments) {
      if (a.kind === 'image') parts.push({ type: 'image', ref: a.id, alt: a.name })
      else if (a.kind === 'audio') parts.push({ type: 'audio', ref: a.id })
      else if (a.kind === 'video') parts.push({ type: 'video', ref: a.id })
      else parts.push({ type: 'file', ref: a.id, name: a.name ?? a.id, mime: a.mime, sizeBytes: a.sizeBytes })
    }
    const labels = attachments.map((a) =>
      a.kind === 'image' ? `[Image: ${a.name ?? a.id}]` : `[File: ${a.name ?? a.id}]`
    )
    const content = [trimmed, ...labels].filter(Boolean).join('\n')
    return { role: 'user', content, parts: parts.length ? parts : undefined, attachments: attachments.length ? attachments : undefined }
  }

  const sendWithMessages = async (
    text: string,
    priorMessages: Message[],
    attachments: MediaRef[] = []
  ): Promise<void> => {
    const normModel = normalizeModelId(modelIdRef.current)
    if (!normModel || !text.trim() || streaming || modelLoadBusy) return
    setChatError(null)
    let sid = sessionId
    if (!sid) {
      try {
        const s = (await engineClient.sessions.create(deriveSessionTitle(text), normModel, systemPrompt)) as {
          id: string
        }
        sid = s.id
        setSessionId(sid)
      } catch (e) {
        setChatError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    try {
      await prepareChatSend(sid, normModel)
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e))
      return
    }
    const userMsg = buildUserMsg(text, attachments)
    const next = [...priorMessages, userMsg]
    setMessages([...next, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)
    window.dispatchEvent(new CustomEvent('omega:streaming-start'))
    void loadSessions()
    const streamId = uuid()
    currentStreamRef.current = streamId
    const disarmChatWatchdog = armChatStreamWatchdog(() => {
      if (currentStreamRef.current !== streamId) return
      setChatError(
        'omega-engine stopped responding (process crashed or restarted). Use Load beside the model, then try again.'
      )
      releaseComposerLocks()
    })
    streamPatch.resetStreamBuffers()
    resetAgentStreamState()
    const offToken = engineClient.chat.onToken(({ streamId: sid2, token }) => {
      if (sid2 !== streamId) return
      streamPatch.appendToken(token.text)
    })
    const offMedia = engineClient.chat.onMedia(({ streamId: sid2, part }) => {
      if (sid2 !== streamId) return
      streamPatch.pushMediaPart(part, (parts, p) => {
        if (p.type === 'content_studio') {
          return upsertContentStudioPart(parts ?? [], p)
        }
        if (p.type === 'video' || p.type === 'audio' || p.type === 'image') {
          const key = `${p.type}:${p.ref}`
          const base = parts ?? []
          const idx = base.findIndex(
            (x) =>
              (x.type === 'video' || x.type === 'audio' || x.type === 'image') &&
              `${x.type}:${x.ref}` === key
          )
          if (idx >= 0) {
            const next = [...base]
            next[idx] = p
            return next
          }
          return [...base, p]
        }
        return [...(parts ?? []), p]
      })
      if (part.type === 'video' || part.type === 'audio' || part.type === 'image') {
        const key =
          part.type === 'video' || part.type === 'audio' || part.type === 'image'
            ? `${part.type}:${part.ref}`
            : undefined
        scrollToRevealMedia(key ? { key } : undefined)
        if (part.type === 'image' && sid) {
          void engineClient.media.showPreview(sid, part).catch(() => {})
        }
        if (part.type === 'audio' && sid) {
          void engineClient.media.showPreview(sid, part).catch(() => {})
        }
      }
    })
    const offErr = engineClient.chat.onError(({ streamId: sid2, error }) => {
      if (sid2 === streamId) setChatError(error)
    })
    try {
      const enableThinking = await resolveEnableThinkingForModel(normModel)
      const result = await engineClient.chat.send({
        streamId,
        sessionId: sid,
        model: normModel,
        messages: [{ role: 'system', content: systemPrompt }, ...next],
        sampling: {
          temperature: 0.7
        },
        enableThinking,
        agentMode,
        attachments: attachments.length ? attachments : undefined
      })
      streamPatch.flush()
      const streamed = streamPatch.getAssistantText()
      const resultParts = (result as { parts?: Message['parts'] } | undefined)?.parts
      const finalText = result?.text?.trim() ? result.text : streamed
      if (finalText.trim() || resultParts?.length) {
        applyFinalAssistantResult(finalText, resultParts)
      } else if (streamed.trim()) {
        applyFinalAssistantResult(streamed)
      } else {
        pruneEmptyAssistantOnError()
      }
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e))
      pruneEmptyAssistantOnError()
    } finally {
      disarmChatWatchdog()
      streamPatch.flush()
      const assistant = streamPatch.getAssistantText()
      offToken()
      offMedia()
      offErr()
      setStreaming(false)
      window.dispatchEvent(new CustomEvent('omega:streaming-end'))
      currentStreamRef.current = null
      if (sid) void syncMessagesFromSession(sid)
      void speakAssistantReply(streamPatch.getAssistantText(), config.omegaTools)
      setTimeout(() => void loadSessions(), 0)
    }
  }

  useEffect(() => {
    const focus = (): void => composerRef.current?.focus()
    const clear = (): void => {
      setMessages([])
      setInput('')
      setChatError(null)
    }
    const newChat = (): void => {
      void clearChatView().then(() => focus())
    }
    const cancel = (): void => {
      const id = currentStreamRef.current
      if (id) engineClient.chat.abort(id).catch(() => {})
    }
    const onFind = (): void => {
      sessionSearchRef.current?.focus()
      sessionSearchRef.current?.select()
    }
    const onFork = (): void => {
      void forkCurrentSession()
    }
    const onDelete = (): void => {
      void deleteCurrentSession()
    }
    const onEdit = (): void => {
      editMessageShortcut()
    }
    window.addEventListener('omega:focus-chat', focus)
    window.addEventListener('omega:clear-chat', clear)
    window.addEventListener('omega:new-chat', newChat)
    window.addEventListener('omega:cancel', cancel)
    window.addEventListener('omega:find', onFind)
    window.addEventListener('omega:fork-chat', onFork)
    window.addEventListener('omega:delete-chat', onDelete)
    window.addEventListener('omega:edit-message', onEdit)
    const onMediaControlError = (e: Event): void => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setChatError(detail)
    }
    window.addEventListener('omega:media-control-error', onMediaControlError)
    return () => {
      window.removeEventListener('omega:focus-chat', focus)
      window.removeEventListener('omega:clear-chat', clear)
      window.removeEventListener('omega:new-chat', newChat)
      window.removeEventListener('omega:cancel', cancel)
      window.removeEventListener('omega:find', onFind)
      window.removeEventListener('omega:fork-chat', onFork)
      window.removeEventListener('omega:delete-chat', onDelete)
      window.removeEventListener('omega:edit-message', onEdit)
      window.removeEventListener('omega:media-control-error', onMediaControlError)
    }
  }, [clearChatView])

  const handleSlash = async (cmd: string): Promise<boolean> => {
    const res = await runSlashCommand(cmd, {
      setAgentMode,
      setSystemPrompt,
      setInput,
      setSessionId,
      setMessages,
      messages,
      sessionId,
      navigate: (p) => onNavigate?.(p),
      runTool: async (name, args) => {
        const r = (await engineClient.tools.run(name, args)) as { output?: string }
        return r?.output ?? JSON.stringify(r)
      }
    })
    if (res.message) {
      if (cmd.trim().startsWith('/help')) setSlashHelpOpen(true)
      else alert(res.message)
    }
    setInput('')
    return res.handled
  }

  const send = async (
    attachments: MediaRef[] = [],
    textOverride?: string,
    opts?: { fromCompanion?: boolean }
  ) => {
    const text = (textOverride ?? input).trim()
    const fromCompanion = opts?.fromCompanion === true

    const failCompanion = (error: string): void => {
      if (!fromCompanion) return
      publishCompanionReply({ userText: text, assistantText: '', done: true, error })
    }

    if ((!text && !attachments.length) || streamingRef.current || modelLoadBusyRef.current) {
      if (fromCompanion) {
        if (!text && !attachments.length) {
          failCompanion('Empty message')
        } else if (streamingRef.current || modelLoadBusyRef.current) {
          failCompanion('Chat is busy — wait for the current reply to finish.')
        }
      }
      return
    }
    setChatError(null)
    if (text.startsWith('/')) {
      if (await handleSlash(text)) {
        if (fromCompanion) {
          failCompanion('Slash commands must be sent from the main chat composer.')
        }
        return
      }
    }

    let normModel = normalizeModelId(modelIdRef.current)
    if (!normModel && fromCompanion) {
      try {
        const resolved = await resolveCompanionModel()
        normModel = resolved.modelId
        if (normModel) {
          setModelId(normModel)
          modelIdRef.current = normModel
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        setChatError(err)
        failCompanion(err)
        return
      }
    }
    if (!normModel) {
      const err = 'No model selected. Download a GGUF in Model Studio or pick one in the dropdown above.'
      setChatError(err)
      failCompanion(err)
      return
    }

    let sid = sessionIdRef.current
    if (!sid && fromCompanion) {
      const resolvedSid = await resolveActiveChatSessionId()
      if (resolvedSid) {
        sid = resolvedSid
        setSessionId(resolvedSid)
        sessionIdRef.current = resolvedSid
      }
    }
    if (!sid) {
      try {
        const s = (await engineClient.sessions.create(deriveSessionTitle(text), normModel, systemPrompt)) as {
          id: string
        }
        sid = s.id
        setSessionId(sid)
        sessionIdRef.current = sid
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const err = msg.includes('file-uri-to-path')
          ? `${msg}\n\nRebuild the app after the latest update (missing SQLite dependency in installer).`
          : msg
        setChatError(err)
        failCompanion(err)
        return
      }
    }
    try {
      await prepareChatSend(sid, normModel)
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setChatError(err)
      failCompanion(err)
      return
    }
    const userMsg = buildUserMsg(text, attachments)
    let prior: Message[]
    if (sid) {
      try {
        const rows = (await engineClient.sessions.messages(sid)) as Message[]
        prior = normalizeSessionMessages(Array.isArray(rows) ? rows : [])
      } catch {
        prior = messagesRef.current.filter(
          (m) => !(m.role === 'assistant' && !String(m.content ?? '').trim())
        )
      }
    } else {
      prior = messagesRef.current.filter(
        (m) => !(m.role === 'assistant' && !String(m.content ?? '').trim())
      )
    }
    const next = [...prior, userMsg]
    setMessages([...next, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)
    window.dispatchEvent(new CustomEvent('omega:streaming-start'))
    void loadSessions()
    const streamId = uuid()
    currentStreamRef.current = streamId
    const disarmChatWatchdog = armChatStreamWatchdog(() => {
      if (currentStreamRef.current !== streamId) return
      setChatError(
        'omega-engine stopped responding (process crashed or restarted). Use Load beside the model, then try again.'
      )
      releaseComposerLocks()
    })
    if (fromCompanion) {
      markCompanionStream(streamId)
      publishCompanionReply({ userText: text, assistantText: '', done: false })
    }
    streamPatch.resetStreamBuffers()
    resetAgentStreamState()

    const pushCompanionReply = (done: boolean, error?: string): void => {
      if (!isCompanionStream(streamId)) return
      publishCompanionReply({
        userText: text,
        assistantText: streamPatch.getAssistantText(),
        done,
        error
      })
    }

    const offToken = engineClient.chat.onToken(({ streamId: sid2, token }) => {
      if (sid2 !== streamId) return
      streamPatch.appendToken(token.text)
      pushCompanionReply(false)
    })
    const offMedia = engineClient.chat.onMedia(({ streamId: sid2, part }) => {
      if (sid2 !== streamId) return
      streamPatch.pushMediaPart(part, (parts, p) => {
        if (p.type === 'content_studio') {
          return upsertContentStudioPart(parts ?? [], p)
        }
        if (p.type === 'video' || p.type === 'audio' || p.type === 'image') {
          const key = `${p.type}:${p.ref}`
          const base = parts ?? []
          const idx = base.findIndex(
            (x) =>
              (x.type === 'video' || x.type === 'audio' || x.type === 'image') &&
              `${x.type}:${x.ref}` === key
          )
          if (idx >= 0) {
            const next = [...base]
            next[idx] = p
            return next
          }
          return [...base, p]
        }
        return [...(parts ?? []), p]
      })
      pushCompanionReply(false)
      if (part.type === 'video' || part.type === 'audio' || part.type === 'image') {
        const key =
          part.type === 'video' || part.type === 'audio' || part.type === 'image'
            ? `${part.type}:${part.ref}`
            : undefined
        scrollToRevealMedia(key ? { key } : undefined)
        if (part.type === 'image' && sid) {
          void engineClient.media.showPreview(sid, part).catch(() => {})
        }
        if (part.type === 'audio' && sid) {
          void engineClient.media.showPreview(sid, part).catch(() => {})
        }
      }
    })
    const offErr = engineClient.chat.onError(({ streamId: sid2, error }) => {
      if (sid2 !== streamId) return
      setChatError(error)
      pushCompanionReply(true, error)
    })

    try {
      const enableThinking = await resolveEnableThinkingForModel(normModel)
      const result = await engineClient.chat.send({
        streamId,
        sessionId: sid,
        model: normModel,
        messages: [{ role: 'system', content: systemPrompt }, ...next],
        sampling: {
          temperature: 0.7
        },
        enableThinking,
        agentMode,
        attachments: attachments.length ? attachments : undefined
      })
      streamPatch.flush()
      const streamed = streamPatch.getAssistantText()
      const resultParts = (result as { parts?: Message['parts'] } | undefined)?.parts
      const finalText = result?.text?.trim() ? result.text : streamed
      if (finalText.trim() || resultParts?.length) {
        applyFinalAssistantResult(finalText, resultParts)
      } else if (streamed.trim()) {
        applyFinalAssistantResult(streamed)
      } else {
        pruneEmptyAssistantOnError()
      }
      const assistant = streamPatch.getAssistantText()
      onLog(`chat done (${assistant.length} chars, ${backend})`)
      void refreshRuntime()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setChatError(msg)
      onLog(`chat error: ${msg}`)
      pushCompanionReply(true, msg)
      pruneEmptyAssistantOnError()
    } finally {
      disarmChatWatchdog()
      offToken()
      offMedia()
      offErr()
      pushCompanionReply(true)
      clearCompanionStream(streamId)
      setStreaming(false)
      window.dispatchEvent(new CustomEvent('omega:streaming-end'))
      currentStreamRef.current = null
      if (sid) void syncMessagesFromSession(sid)
      void refreshContextTokens()
      onRefresh()
      setTimeout(() => void loadSessions(), 0)
    }
  }

  useEffect(() => {
    const onCompanionToChat = (e: Event): void => {
      const d = (e as CustomEvent<CompanionToChatDetail>).detail
      if (!d?.text?.trim() && !d.attachments?.length) return
      onNavigate?.('chat')
      window.dispatchEvent(new CustomEvent('omega:focus-chat'))
      void sendRef.current(d.attachments ?? [], d.text, { fromCompanion: true }).catch((err) => {
        publishCompanionReply({
          userText: d.text,
          assistantText: '',
          done: true,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }
    window.addEventListener(COMPANION_TO_CHAT_EVENT, onCompanionToChat)
    return () => window.removeEventListener(COMPANION_TO_CHAT_EVENT, onCompanionToChat)
  }, [onNavigate])

  const sendRef = useRef(send)
  sendRef.current = send

  const pickerModels = chatModels.length > 0 ? chatModels : models
  const localPickerModels = pickerModels.filter((m) => !m.remote && !m.id.startsWith('ollama:'))
  const ollamaPickerModels = pickerModels.filter((m) => m.id.startsWith('ollama:'))
  const remotePickerModels = pickerModels.filter((m) => m.remote)

  const modelOptionLabel = (m: (typeof pickerModels)[number]): string =>
    m.displayName ?? m.id

  return (
    <div className="flex h-full min-h-0">
      <ResizablePanel
        side="left"
        width={layout.leftWidth}
        hidden={layout.leftHidden}
        minWidth={180}
        maxWidth={420}
        onWidthChange={(leftWidth) => persistLayout({ leftWidth })}
        onHiddenChange={(leftHidden) => persistLayout({ leftHidden })}
        onResizeEnd={() => {
          setLayout((current) => {
            saveLayoutPrefs(CHAT_LAYOUT_KEY, current)
            return current
          })
        }}
        className="flex flex-col"
      >
        <div className="shrink-0 space-y-2 border-b border-zinc-800 p-3">
          <button
            type="button"
            onClick={newSession}
            className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-500"
          >
            + New chat
          </button>
          <input
            ref={sessionSearchRef}
            type="search"
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
            placeholder="Search chats… (Ctrl+F)"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs"
          />
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 text-sm">
          {filteredSessions.length === 0 && (
            <li className="px-2 py-4 text-center text-xs text-zinc-500">No chats match</li>
          )}
          {filteredSessions.map((s) => (
            <li key={s.id} className="group relative">
              <button
                type="button"
                onClick={() => selectSession(s.id)}
                className={`w-full rounded-lg px-2 py-2 pr-14 text-left ${
                  sessionId === s.id ? 'bg-indigo-600/25 ring-1 ring-indigo-500/50' : 'hover:bg-zinc-800'
                }`}
              >
                <p className="truncate text-zinc-200">{s.title}</p>
                <p className="truncate text-[10px] text-zinc-500">{s.modelId}</p>
              </button>
              <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  title="Fork chat (Ctrl+Shift+D)"
                  onClick={(e) => {
                    e.stopPropagation()
                    void forkSession(s.id)
                  }}
                  className="rounded px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-indigo-200"
                >
                  ⎇
                </button>
                <button
                  type="button"
                  title="Delete chat (Ctrl+Shift+Backspace)"
                  onClick={(e) => {
                    e.stopPropagation()
                    requestDeleteSession(s.id)
                  }}
                  className="rounded px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-rose-300"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      </ResizablePanel>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-950/80 px-3 py-2">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Model</span>
            {modelInMemory && (
              <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[9px] text-emerald-300">
                {isRemoteModel ? 'cloud' : 'loaded'}
              </span>
            )}
            <select
                value={normalizeModelId(modelId)}
                onChange={(e) => {
                  const next = normalizeModelId(e.target.value)
                  setModelId(next)
                  if (sessionId) void syncSessionModelId(sessionId, next)
                }}
                className="min-w-[12rem] max-w-full flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
                title="Active chat model"
              >
                {pickerModels.length === 0 && (
                  <option value="">No models — add a provider or download a GGUF</option>
                )}
                {remotePickerModels.length > 0 && (
                  <optgroup label="Cloud APIs (OpenRouter, etc.)">
                    {remotePickerModels.map((m) => (
                      <option key={m.id} value={normalizeModelId(m.id)}>
                        {modelOptionLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {localPickerModels.length > 0 && (
                  <optgroup label="Local GGUF">
                    {localPickerModels.map((m) => (
                      <option key={m.id} value={normalizeModelId(m.id)}>
                        {modelOptionLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {ollamaPickerModels.length > 0 && (
                  <optgroup label="Bundled Ollama">
                    {ollamaPickerModels.map((m) => (
                      <option key={m.id} value={normalizeModelId(m.id)}>
                        {modelOptionLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {remotePickerModels.length === 0 && (
                <button
                  type="button"
                  onClick={() => onNavigate?.('providers')}
                  className="rounded-lg border border-indigo-600/60 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-950/40"
                >
                  + Cloud API
                </button>
              )}
              {canLoadUnload &&
                (modelInMemory ? (
                  <button
                    type="button"
                    disabled={modelLoadBusy || streaming}
                    onClick={() => void unloadModelFromMemory()}
                    className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Unload
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={modelLoadBusy || streaming}
                    onClick={() => void loadModelIntoMemory(modelId)}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  >
                    Load
                  </button>
                ))}
              <span className="text-[10px] text-zinc-500">
                backend: {isRemoteModel ? 'cloud' : backend}
              </span>
              {!isRemoteModel && isLocalModelId(modelId) && (
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">
                  manual tuning
                </span>
              )}
              {ctxInfo && <span className="text-[10px] text-zinc-600">{ctxInfo}</span>}
            {onOpenModels && (
              <button
                type="button"
                onClick={onOpenModels}
                className="rounded-lg border border-zinc-600 px-2 py-1.5 text-xs text-indigo-300 hover:bg-zinc-800"
              >
                Models
              </button>
            )}
            <button
              type="button"
              onClick={() => setSlashHelpOpen(true)}
              className="rounded-lg border border-zinc-600 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
              title="Slash commands (/help)"
            >
              /help
            </button>
          </div>
          <AgentStepStrip
            steps={agentSteps}
            onClear={onClearAgentSteps}
            onOpenAgent={onNavigate ? () => onNavigate('agent') : undefined}
          />
          <div className="flex flex-wrap items-start gap-1.5">
            <div className="min-w-0 flex-1 basis-[calc(50%-0.375rem)]">
              <CollapsibleSection
                title="Session options"
                compact
                defaultOpen={false}
                compactExpandedMaxHeight={420}
              >
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} />
                Agent mode (Assistant tools + memory)
              </label>
              <p className="text-[10px] text-zinc-500">
                With agent mode on, Ωmega injects the full Assistant system prompt (media, browser, tools)
                plus your session notes below.
              </p>
              <label className="block text-xs text-zinc-400">
                Session preferences (added to Assistant prompt)
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={2}
                  placeholder="Optional: tone, project context, standing instructions…"
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
                  onClick={() => setSystemPrompt(DEFAULT_OMEGA_SYSTEM_PROMPT)}
                >
                  Reset to default
                </button>
                <button
                  type="button"
                  className="rounded border border-indigo-800 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-950/40"
                  onClick={async () => {
                    if (!assistantPreviewOpen) {
                      setFullAssistantPrompt(await engineClient.assistant.defaultPrompt())
                    }
                    setAssistantPreviewOpen((o) => !o)
                  }}
                >
                  {assistantPreviewOpen ? 'Hide' : 'View'} Assistant prompt
                </button>
              </div>
              {assistantPreviewOpen && fullAssistantPrompt && (
                <pre className="max-h-36 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-[10px] whitespace-pre-wrap text-zinc-400">
                  {fullAssistantPrompt}
                </pre>
              )}
            </div>
          </CollapsibleSection>
            </div>
            <div className="min-w-0 flex-1 basis-[calc(50%-0.375rem)]">
              <ProjectKnowledgePanel sessionId={sessionId} compact />
            </div>
          </div>
        </div>

        {(modelLoadBusy || modelLoadStatus) && (
          <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
            <ModelLoadProgressBar
              active={modelLoadBusy || Boolean(modelLoadStatus)}
              percent={modelLoadPercent}
              label={modelLoadStatus ?? 'Loading model…'}
            />
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <div
            ref={messagesScrollRef}
            onScroll={onMessagesScroll}
            className="omega-chat-messages h-full overflow-y-auto overflow-x-hidden px-4 py-3"
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
          >
          {messages.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">
              {sessionId
                ? 'Send a message to start this chat.'
                : filteredSessions.length === 0
                  ? 'No chats yet. Type below to start one, or use + New chat.'
                  : 'Type a message below to start a new chat.'}
            </p>
          )}
          {messages.length > 0 && !useVirtualMessages && (
            <div className="space-y-0">
              {messages.map((_, i) => (
                <div key={`${sessionId ?? 'new'}-${i}`}>{renderMessageRow(i)}</div>
              ))}
            </div>
          )}
          {messages.length > 0 && useVirtualMessages && (
            <div
              style={{
                height: messageVirtualizer.getTotalSize(),
                width: '100%',
                position: 'relative'
              }}
            >
              {messageVirtualizer.getVirtualItems().map((virtualRow) => {
                const i = virtualRow.index
                return (
                  <div
                    key={virtualRow.key}
                    data-index={i}
                    ref={messageVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                  >
                    {renderMessageRow(i)}
                  </div>
                )
              })}
            </div>
          )}
          <ChatExtensionApproval />
          <ChatToolApproval />
          <ChatCapabilityApproval
            onConfigUpdated={() => {
              void engineClient.config.get().then((c) => {
                /* parent App holds config; notify via global refresh if available */
                window.dispatchEvent(new CustomEvent('omega-config-changed', { detail: c }))
              })
            }}
          />
          <div ref={mediaPanelRef}>
            <ChatMediaReviewPanel
              chatActive={chatActive}
              overlayEpoch={overlayEpoch}
              suppressInlineYoutube={inlineYoutubeInChat}
              onOpenBrowser={onNavigate ? () => onNavigate('browser') : undefined}
              onVisible={handleMediaPanelVisible}
            />
          </div>
          <div ref={bottomRef} />
          </div>
          {showScrollToBottom && (
            <button
              type="button"
              onClick={() => scrollMessagesToBottom('smooth')}
              className="absolute bottom-3 right-6 z-10 rounded-full border border-indigo-500/50 bg-indigo-950/90 px-3 py-1.5 text-xs font-medium text-indigo-200 shadow-lg hover:bg-indigo-900"
              title="Scroll to latest messages"
            >
              ↓ Latest
            </button>
          )}
        </div>

        {chatErrorHint ? (
          <div className="border-t border-zinc-800 px-3 pt-2">
            <AgentErrorBanner
              hint={chatErrorHint}
              onNavigate={onNavigate}
              onDismiss={() => setChatError(null)}
            />
          </div>
        ) : null}

        <OmegaTerminalPanel
          sessionId={sessionId}
          onOpenBrowser={onNavigate ? () => onNavigate('browser') : undefined}
        />

        <div
          className="relative z-10 shrink-0 bg-zinc-950"
          onMouseDown={(e) => {
            e.stopPropagation()
            if (e.target === e.currentTarget) composerRef.current?.focus()
          }}
        >
          <ChatComposer
            key={`composer-${sessionId ?? 'none'}-${overlayEpoch}`}
            ref={composerRef}
            value={input}
            onChange={setInput}
            sessionId={sessionId}
            streaming={streaming}
            disabled={streaming || modelLoadBusy}
            modelId={modelId}
            voiceEnabled={voiceInputEnabled}
            onEnsureSession={ensureSession}
            onSend={(atts, textOverride) => void send(atts, textOverride)}
          />
        </div>
      </div>

      {slashHelpOpen && <SlashHelpModal onClose={() => setSlashHelpOpen(false)} />}

      {editTarget && (
        <EditMessageModal
          initialContent={editTarget.content}
          busy={streaming}
          onCancel={() => setEditTarget(null)}
          onSubmit={(text) => void submitEditMessage(text)}
        />
      )}

      {deleteConfirmId && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onMouseDown={() => setDeleteConfirmId(null)}
        >
          <div
            role="dialog"
            aria-labelledby="delete-chat-title"
            className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="delete-chat-title" className="text-sm font-medium text-zinc-100">
              Delete this chat permanently?
            </h2>
            <p className="mt-2 text-xs text-zinc-400">This cannot be undone.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                onClick={() => setDeleteConfirmId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-600"
                onClick={() => {
                  const id = deleteConfirmId
                  setDeleteConfirmId(null)
                  void executeDeleteSession(id)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}