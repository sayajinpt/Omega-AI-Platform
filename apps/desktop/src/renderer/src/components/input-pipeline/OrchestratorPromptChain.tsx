import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  InputPipeline,
  OrchestratorExecuteRound,
  OrchestratorPromptDefaults,
  OrchestratorPromptOverrides,
  PipelineNode
} from '@omega/sdk'
import { orchestratorPromptsCustomized } from '@omega/sdk'
import { engineClient } from '../../lib/engine'

type PromptSectionKey =
  | 'planInstructions'
  | 'contextRules'
  | 'chatTools'
  | 'agentTools'
  | 'executeInstructions'
  | 'toolResultsContinuation'

type ChainStep =
  | { kind: 'plan'; key: PromptSectionKey; label: string }
  | { kind: 'execute'; round: number; label: string }
  | { kind: 'continuation'; key: 'toolResultsContinuation'; label: string }

const PLAN_SECTIONS: ChainStep[] = [
  { kind: 'plan', key: 'planInstructions', label: 'Plan instructions (PROMPT_1)' },
  { kind: 'plan', key: 'contextRules', label: 'Context rules' },
  { kind: 'plan', key: 'chatTools', label: 'Chat tools' },
  { kind: 'plan', key: 'agentTools', label: 'Agent tools' }
]

const txt =
  'w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] leading-relaxed'

function orchNode(pipeline: InputPipeline): Extract<PipelineNode, { kind: 'chat_orchestrator' }> | null {
  const n = pipeline.nodes.find((row) => row.kind === 'chat_orchestrator')
  return n?.kind === 'chat_orchestrator' ? n : null
}

function readSection(
  defaults: OrchestratorPromptDefaults,
  overrides: OrchestratorPromptOverrides | undefined,
  key: PromptSectionKey
): string {
  const custom = overrides?.[key]
  if (typeof custom === 'string' && custom.length > 0) return custom
  return defaults[key]
}

function patchOverrides(
  node: Extract<PipelineNode, { kind: 'chat_orchestrator' }>,
  patch: OrchestratorPromptOverrides | undefined
): Extract<PipelineNode, { kind: 'chat_orchestrator' }> {
  if (!patch || !orchestratorPromptsCustomized(patch)) {
    const { promptOverrides: _removed, ...rest } = node
    return rest
  }
  return { ...node, promptOverrides: patch }
}

export function OrchestratorPromptChain({
  draft,
  onChange
}: {
  draft: InputPipeline
  onChange: (next: InputPipeline) => void
}) {
  const node = orchNode(draft)
  const [defaults, setDefaults] = useState<OrchestratorPromptDefaults | null>(null)
  const [activeStep, setActiveStep] = useState<string>('planInstructions')
  const overrides = node?.promptOverrides

  useEffect(() => {
    void engineClient.orchestratorPrompts.getDefaults().then(setDefaults).catch(() => setDefaults(null))
  }, [])

  const executeRounds = overrides?.executeRounds ?? []

  const steps = useMemo((): ChainStep[] => {
    const rows: ChainStep[] = [...PLAN_SECTIONS]
    rows.push({ kind: 'execute', round: 1, label: 'Execute round 1 (PROMPT_2)' })
    executeRounds.forEach((r, i) => {
      rows.push({
        kind: 'execute',
        round: i + 2,
        label: r.label?.trim() || `Execute round ${i + 2}`
      })
    })
    rows.push({
      kind: 'continuation',
      key: 'toolResultsContinuation',
      label: 'After tool results (between execute rounds)'
    })
    return rows
  }, [executeRounds])

  const updateNode = useCallback(
    (nextNode: Extract<PipelineNode, { kind: 'chat_orchestrator' }>) => {
      onChange({
        ...draft,
        nodes: draft.nodes.map((n) => (n.id === nextNode.id ? nextNode : n))
      })
    },
    [draft, onChange]
  )

  const setOverrideField = (key: PromptSectionKey, value: string, defaultValue: string) => {
    if (!node || !defaults) return
    const next: OrchestratorPromptOverrides = { ...(overrides ?? {}) }
    if (value === defaultValue) delete next[key]
    else next[key] = value
    updateNode(patchOverrides(node, next))
  }

  const setExecuteRoundText = (roundIndex: number, value: string) => {
    if (!node || !defaults) return
    const next: OrchestratorPromptOverrides = { ...(overrides ?? {}) }
    const rounds: OrchestratorExecuteRound[] = [...(next.executeRounds ?? [])]
    while (rounds.length <= roundIndex) {
      rounds.push({
        id: `r${rounds.length + 2}-${Date.now().toString(36).slice(-4)}`,
        label: `Execute round ${rounds.length + 2}`
      })
    }
    const row = rounds[roundIndex]!
    if (value === defaults.executeInstructions) delete row.instructions
    else row.instructions = value
    next.executeRounds = rounds
    updateNode(patchOverrides(node, next))
  }

  const addExecuteRound = () => {
    if (!node) return
    const next: OrchestratorPromptOverrides = { ...(overrides ?? {}) }
    const rounds = [...(next.executeRounds ?? [])]
    rounds.push({
      id: `r${rounds.length + 2}-${Date.now().toString(36)}`,
      label: `Execute round ${rounds.length + 2}`
    })
    next.executeRounds = rounds
    updateNode(patchOverrides(node, next))
    setActiveStep(`execute-${rounds.length + 1}`)
  }

  const removeExecuteRound = (roundIndex: number) => {
    if (!node) return
    const next: OrchestratorPromptOverrides = { ...(overrides ?? {}) }
    const rounds = [...(next.executeRounds ?? [])]
    rounds.splice(roundIndex, 1)
    if (rounds.length) next.executeRounds = rounds
    else delete next.executeRounds
    updateNode(patchOverrides(node, next))
    setActiveStep('executeInstructions')
  }

  const restoreAll = () => {
    if (!node) return
    updateNode(patchOverrides(node, undefined))
    setActiveStep('planInstructions')
  }

  const restoreSection = (key: PromptSectionKey) => {
    if (!node || !overrides) return
    const next = { ...overrides }
    delete next[key]
    updateNode(patchOverrides(node, next))
  }

  const customized = orchestratorPromptsCustomized(overrides)

  if (!node) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
        Add a Chat orchestrator node to edit prompt chains.
      </div>
    )
  }

  if (!defaults) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
        Loading default orchestrator prompts…
      </div>
    )
  }

  let editorValue = ''
  let editorDefault = ''
  let onEditorChange = (_v: string) => {}
  let onRestore = () => {}

  if (activeStep === 'executeInstructions' || activeStep.startsWith('execute-')) {
    const roundNum =
      activeStep === 'executeInstructions' ? 1 : Number(activeStep.replace('execute-', ''))
    editorDefault = defaults.executeInstructions
    if (roundNum === 1) {
      editorValue = overrides?.executeInstructions?.trim()
        ? overrides.executeInstructions
        : defaults.executeInstructions
      onEditorChange = (v) => setOverrideField('executeInstructions', v, defaults.executeInstructions)
      onRestore = () => restoreSection('executeInstructions')
    } else {
      const idx = roundNum - 2
      const custom = executeRounds[idx]?.instructions
      editorValue = custom?.trim() ? custom : defaults.executeInstructions
      onEditorChange = (v) => setExecuteRoundText(idx, v)
      onRestore = () => setExecuteRoundText(idx, defaults.executeInstructions)
    }
  } else if (
    activeStep === 'planInstructions' ||
    activeStep === 'contextRules' ||
    activeStep === 'chatTools' ||
    activeStep === 'agentTools' ||
    activeStep === 'toolResultsContinuation'
  ) {
    const key = activeStep as PromptSectionKey
    editorDefault = defaults[key]
    editorValue = readSection(defaults, overrides, key)
    onEditorChange = (v) => setOverrideField(key, v, defaults[key])
    onRestore = () => restoreSection(key)
  }

  const activePlan = steps.find(
    (s) =>
      (s.kind === 'plan' && s.key === activeStep) ||
      (s.kind === 'continuation' && s.key === activeStep) ||
      (s.kind === 'execute' &&
        (activeStep === 'executeInstructions'
          ? s.round === 1
          : activeStep === `execute-${s.round}`))
  )

  const stepCustomized = (step: ChainStep): boolean => {
    if (step.kind === 'plan') return Boolean(overrides?.[step.key]?.trim())
    if (step.kind === 'continuation') return Boolean(overrides?.toolResultsContinuation?.trim())
    if (step.round === 1) return Boolean(overrides?.executeInstructions?.trim())
    const idx = step.round - 2
    return Boolean(executeRounds[idx]?.instructions?.trim())
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/30 p-2">
        <div className="mb-2 flex items-center justify-between gap-1 px-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Prompt chain
          </span>
          {customized && (
            <span className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[9px] text-amber-400">
              customized
            </span>
          )}
        </div>
        <ol className="space-y-0.5">
          {steps.map((step, i) => {
            const id =
              step.kind === 'plan'
                ? step.key
                : step.kind === 'continuation'
                  ? step.key
                  : step.round === 1
                    ? 'executeInstructions'
                    : `execute-${step.round}`
            const active = activeStep === id
            return (
              <li key={`${id}-${i}`}>
                <button
                  type="button"
                  onClick={() => setActiveStep(id)}
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${
                    active ? 'bg-indigo-950/50 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  <span className="mt-0.5 shrink-0 font-mono text-[10px] text-zinc-600">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{step.label}</span>
                    {stepCustomized(step) && (
                      <span className="text-[9px] text-amber-500/90">edited</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        <button
          type="button"
          onClick={addExecuteRound}
          className="mt-3 w-full rounded border border-dashed border-zinc-700 py-1.5 text-[10px] text-zinc-400 hover:border-indigo-700 hover:text-indigo-300"
        >
          + Add execute round
        </button>
        {customized && (
          <button
            type="button"
            onClick={restoreAll}
            className="mt-2 w-full rounded border border-zinc-700 py-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          >
            Restore all defaults
          </button>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
          <h3 className="text-sm font-medium text-zinc-200">
            {activePlan?.label ?? 'Select a prompt step'}
          </h3>
          {activeStep.startsWith('execute-') && activeStep !== 'executeInstructions' && (
            <button
              type="button"
              onClick={() => removeExecuteRound(Number(activeStep.replace('execute-', '')) - 2)}
              className="rounded border border-red-900/60 px-2 py-0.5 text-[10px] text-red-400"
            >
              Remove round
            </button>
          )}
          <button
            type="button"
            onClick={onRestore}
            className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          >
            Restore default
          </button>
        </header>
        <p className="border-b border-zinc-800 px-4 py-1.5 text-[10px] text-zinc-500">
          Built-in defaults stay in the runtime. Edits are saved on this pipeline only — restore anytime
          to use defaults again.
        </p>
        <textarea
          className={`${txt} m-4 min-h-0 flex-1 resize-none`}
          value={editorValue}
          onChange={(e) => onEditorChange(e.target.value)}
          spellCheck={false}
        />
        {editorValue !== editorDefault && (
          <p className="px-4 pb-3 text-[10px] text-amber-500/80">
            This section differs from the built-in default.
          </p>
        )}
      </div>
    </div>
  )
}
