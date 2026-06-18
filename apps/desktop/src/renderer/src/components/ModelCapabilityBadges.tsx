import { inferModelCapabilities, type ModelCapabilityInput } from '@omega/sdk'

export function ModelCapabilityBadges({
  input,
  compact,
  max = 6
}: {
  input: ModelCapabilityInput
  compact?: boolean
  max?: number
}) {
  const caps = inferModelCapabilities(input).slice(0, max)
  if (caps.length === 0) return null

  return (
    <div className={`flex flex-wrap gap-1 ${compact ? '' : 'mt-2'}`}>
      {caps.map((c) => (
        <span
          key={c.id}
          title={c.title}
          className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 ring-1 ${
            compact ? 'text-[9px]' : 'text-[10px]'
          } ${c.tone}`}
        >
          <span aria-hidden>{c.icon}</span>
          <span>{c.label}</span>
        </span>
      ))}
    </div>
  )
}
