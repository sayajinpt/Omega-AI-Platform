import { inferModelCapabilities, primaryModelTaskLabel, type ModelCapabilityInput } from '@omega/sdk'

export function ModelCapabilityBadges({
  input,
  compact,
  max = 6
}: {
  input: ModelCapabilityInput
  compact?: boolean
  max?: number
}) {
  const taskLabel = primaryModelTaskLabel(input)
  const generationIds = new Set([
    'text-to-video',
    'text-to-image',
    'image-to-video',
    'image-to-image',
    'image-text-to-text',
    'text-to-speech',
    'speech-to-text',
    'any-to-any',
    'embedding',
    'audio'
  ])
  const caps = inferModelCapabilities(input)
    .filter((c) => !taskLabel || !generationIds.has(c.id))
    .slice(0, max)
  if (caps.length === 0 && !taskLabel) return null

  return (
    <div className={`flex flex-wrap gap-1 ${compact ? '' : 'mt-2'}`}>
      {taskLabel && (
        <span
          title={`HF task: ${input.pipeline ?? taskLabel}`}
          className={`inline-flex items-center gap-0.5 rounded-md bg-indigo-950/70 px-1.5 py-0.5 font-medium text-indigo-200 ring-1 ring-indigo-600/50 ${
            compact ? 'text-[9px]' : 'text-[10px]'
          }`}
        >
          {taskLabel}
        </span>
      )}
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
