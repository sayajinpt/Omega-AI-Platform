import type { ModelInfo, PipelineNode } from '@omega/sdk'

const txt = 'w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs'

export function PipelineNodeEditor({
  node,
  models,
  onChange
}: {
  node: PipelineNode
  models: ModelInfo[]
  onChange: (patch: Partial<PipelineNode>) => void
}) {
  if (node.kind === 'user_input') {
    return <p className="text-xs text-zinc-500">Entry point for user messages.</p>
  }
  if (node.kind === 'chat_orchestrator') {
    return (
      <div className="space-y-2">
        <label className="block text-[10px] text-zinc-500">
          Chat model (optional override)
          <select
            className={`${txt} mt-1`}
            value={node.modelId ?? ''}
            onChange={(e) => onChange({ modelId: e.target.value || undefined })}
          >
            <option value="">Default chat model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] text-zinc-500">
          System addendum
          <textarea
            className={`${txt} mt-1 resize-none`}
            rows={3}
            value={node.systemAddendum ?? ''}
            onChange={(e) => onChange({ systemAddendum: e.target.value || undefined })}
            placeholder="Extra instructions for this orchestrator node"
          />
        </label>
        <label className="flex items-start gap-2 text-[10px] text-zinc-500">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={node.twoPhaseEnabled ?? false}
            onChange={(e) => onChange({ twoPhaseEnabled: e.target.checked || undefined })}
          />
          <span>
            <span className="text-zinc-300">Two-phase plan → execute</span> (advanced). Requires
            models that follow <code className="text-indigo-300">&lt;omega_turn&gt;</code> markup.
            Leave off for universal tool calling (recommended for all model families).
          </span>
        </label>
      </div>
    )
  }
  if (node.kind === 'proxy_model') {
    return (
      <div className="space-y-2">
        <label className="block text-[10px] text-zinc-500">
          Proxy model
          <select
            className={`${txt} mt-1`}
            value={node.modelId}
            onChange={(e) => onChange({ modelId: e.target.value })}
          >
            <option value="">Select model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] text-zinc-500">
          Adapter path
          <input
            className={`${txt} mt-1`}
            value={node.adapterPath ?? ''}
            onChange={(e) => onChange({ adapterPath: e.target.value || undefined })}
            placeholder="Optional LoRA / adapter path"
          />
        </label>
        <label className="block text-[10px] text-zinc-500">
          Prompt template
          <textarea
            className={`${txt} mt-1 resize-none font-mono`}
            rows={3}
            value={node.promptTemplate ?? ''}
            onChange={(e) => onChange({ promptTemplate: e.target.value || undefined })}
            placeholder="{{input}}"
          />
        </label>
      </div>
    )
  }
  if (node.kind === 'tts_model' || node.kind === 'image_model') {
    return (
      <label className="block text-[10px] text-zinc-500">
        Model override
        <select
          className={`${txt} mt-1`}
          value={node.modelId ?? ''}
          onChange={(e) => onChange({ modelId: e.target.value || undefined })}
        >
          <option value="">Use Model roles default</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return null
}
