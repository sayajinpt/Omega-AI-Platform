import type { AgentStep } from '@omega/sdk'

const KIND_COLOR: Record<AgentStep['kind'], string> = {
  plan: 'border-indigo-700 bg-indigo-950/30',
  execute: 'border-sky-700 bg-sky-950/30',
  tool: 'border-amber-700 bg-amber-950/30',
  critic: 'border-fuchsia-700 bg-fuchsia-950/30',
  respond: 'border-emerald-700 bg-emerald-950/30'
}

interface TreeNode {
  step: AgentStep
  children: TreeNode[]
}

function buildTree(steps: AgentStep[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const s of steps) byId.set(s.id, { step: s, children: [] })
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    if (node.step.parentId && byId.has(node.step.parentId)) {
      byId.get(node.step.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function StepNode({ node }: { node: TreeNode }) {
  const s = node.step
  const colors = KIND_COLOR[s.kind] ?? 'border-zinc-700 bg-zinc-900/50'
  const statusColor =
    s.status === 'done'
      ? 'bg-emerald-500'
      : s.status === 'error'
        ? 'bg-red-500'
        : s.status === 'running'
          ? 'bg-amber-400 animate-pulse'
          : 'bg-zinc-600'
  const elapsed = s.endedAt && s.startedAt ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : '…'
  return (
    <li>
      <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${colors}`}>
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase text-zinc-300">{s.kind}</span>
            <span className="text-[10px] text-zinc-500">{elapsed}</span>
          </div>
          <p className="text-sm text-zinc-100">{s.title}</p>
          {s.detail && (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] text-zinc-400">
              {s.detail}
            </pre>
          )}
        </div>
      </div>
      {node.children.length > 0 && (
        <ul className="ml-5 mt-1 space-y-1 border-l border-zinc-800 pl-3">
          {node.children.map((c) => (
            <StepNode key={c.step.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function AgentGraph({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-zinc-500">Run the agent to see the execution graph.</p>
  }
  const tree = buildTree(steps)
  return (
    <ul className="space-y-2">
      {tree.map((n) => (
        <StepNode key={n.step.id} node={n} />
      ))}
    </ul>
  )
}
