import type { ModelInfo, WorkflowNode } from '@omega/sdk'

export function WorkflowNodeEditor({
  node,
  onChange,
  models
}: {
  node: WorkflowNode
  onChange: (patch: Partial<WorkflowNode>) => void
  models: ModelInfo[]
}) {
  const txt = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs'
  if (node.kind === 'prompt') {
    return (
      <div className="space-y-2">
        <textarea
          value={node.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={4}
          className={`${txt} font-mono`}
          placeholder="Prompt (use {{var}} for variables)"
        />
        <textarea
          value={node.system ?? ''}
          onChange={(e) => onChange({ system: e.target.value })}
          rows={2}
          className={`${txt} font-mono`}
          placeholder="System prompt (optional)"
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-zinc-500">
            Max tokens
            <input
              type="number"
              value={node.maxTokens ?? 512}
              onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
              className={txt}
            />
          </label>
          <label className="text-[10px] text-zinc-500">
            Temperature
            <input
              type="number"
              step="0.1"
              value={node.temperature ?? 0.5}
              onChange={(e) => onChange({ temperature: Number(e.target.value) })}
              className={txt}
            />
          </label>
        </div>
        <select
          value={node.model ?? ''}
          onChange={(e) => onChange({ model: e.target.value })}
          className={txt}
        >
          <option value="">(default model)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <input
          value={node.output ?? ''}
          onChange={(e) => onChange({ output: e.target.value })}
          placeholder="Output variable name"
          className={txt}
        />
        <label className="flex items-center gap-2 text-[10px] text-zinc-500">
          <input
            type="checkbox"
            checked={node.continueOnError === true}
            onChange={(e) => onChange({ continueOnError: e.target.checked })}
          />
          Continue on error
        </label>
      </div>
    )
  }
  if (node.kind === 'tool') {
    return (
      <div className="space-y-2">
        <input
          value={node.tool}
          onChange={(e) => onChange({ tool: e.target.value })}
          placeholder="tool name (e.g. web_fetch)"
          className={txt}
        />
        <textarea
          value={JSON.stringify(node.args ?? {}, null, 2)}
          onChange={(e) => {
            try {
              onChange({ args: JSON.parse(e.target.value) as Record<string, string> })
            } catch {
              /* ignore invalid JSON while typing */
            }
          }}
          rows={5}
          className={`${txt} font-mono`}
        />
        <input
          value={node.output ?? ''}
          onChange={(e) => onChange({ output: e.target.value })}
          placeholder="Output variable"
          className={txt}
        />
        <label className="flex items-center gap-2 text-[10px] text-zinc-500">
          <input
            type="checkbox"
            checked={node.continueOnError === true}
            onChange={(e) => onChange({ continueOnError: e.target.checked })}
          />
          Continue on error
        </label>
      </div>
    )
  }
  if (node.kind === 'agent') {
    return (
      <div className="space-y-2">
        <textarea
          value={node.input}
          onChange={(e) => onChange({ input: e.target.value })}
          rows={4}
          placeholder="Agent task input ({{vars}} supported)"
          className={`${txt} font-mono`}
        />
        <select
          value={node.model ?? ''}
          onChange={(e) => onChange({ model: e.target.value })}
          className={txt}
        >
          <option value="">(default model)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <label className="text-[10px] text-zinc-500">
          Max steps
          <input
            type="number"
            value={node.maxSteps ?? 6}
            onChange={(e) => onChange({ maxSteps: Number(e.target.value) })}
            className={txt}
          />
        </label>
        <input
          value={node.output ?? ''}
          onChange={(e) => onChange({ output: e.target.value })}
          placeholder="Output variable"
          className={txt}
        />
      </div>
    )
  }
  if (node.kind === 'branch') {
    return (
      <div className="space-y-2">
        <input
          value={node.condition}
          onChange={(e) => onChange({ condition: e.target.value })}
          placeholder="Condition expression (true/false)"
          className={txt}
        />
        <input
          value={node.output ?? ''}
          onChange={(e) => onChange({ output: e.target.value })}
          placeholder="Output variable"
          className={txt}
        />
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <input
        value={node.kind === 'set' ? node.value : ''}
        onChange={(e) => onChange({ value: e.target.value } as Partial<WorkflowNode>)}
        placeholder="Value (variables supported)"
        className={txt}
      />
      <input
        value={node.output ?? ''}
        onChange={(e) => onChange({ output: e.target.value })}
        placeholder="Output variable"
        className={txt}
      />
    </div>
  )
}
