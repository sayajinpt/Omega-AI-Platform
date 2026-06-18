import type { Dispatch, SetStateAction } from 'react'
import type { GpuAttentionMode, GpuAttentionSettings, OmegaConfig } from '@omega/sdk'

const MODE_OPTS: Array<{ value: GpuAttentionMode; label: string; hint: string }> = [
  {
    value: 'auto',
    label: 'Auto (recommended)',
    hint: 'PyTorch SDPA / diffusers or native llama.cpp kernels — picks the best path per GPU and tensor shape.'
  },
  {
    value: 'flash',
    label: 'Flash attention',
    hint: 'Force flash-attn when the wheel is installed (~250 MB on first Content Studio setup).'
  },
  {
    value: 'off',
    label: 'Off',
    hint: 'Never request flash-attn; use standard attention only.'
  }
]

function resolveMode(
  mode: GpuAttentionMode | undefined,
  legacyEnabled: boolean | undefined,
  defaultMode: GpuAttentionMode
): GpuAttentionMode {
  if (mode) return mode
  if (legacyEnabled === false) return 'off'
  if (legacyEnabled === true) return 'flash'
  return defaultMode
}

export function GpuAttentionSettingsBlock({
  draft,
  setDraft
}: {
  draft: OmegaConfig
  setDraft: Dispatch<SetStateAction<OmegaConfig>>
}) {
  const attn: GpuAttentionSettings = draft.gpuAttention ?? {}
  const chatMode = resolveMode(attn.chatMode, attn.chatEnabled, 'auto')
  const csMode = resolveMode(attn.contentStudioMode, attn.contentStudioEnabled, 'auto')

  const setAttn = (patch: Partial<GpuAttentionSettings>) => {
    setDraft((d) => ({
      ...d,
      gpuAttention: {
        ...d.gpuAttention,
        ...patch
      }
    }))
  }

  const modeSelect = (
    id: string,
    label: string,
    sub: string,
    value: GpuAttentionMode,
    onChange: (m: GpuAttentionMode) => void
  ) => (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-zinc-200">
        {label}
        <span className="block text-xs font-normal text-zinc-500 mt-0.5">{sub}</span>
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as GpuAttentionMode)}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
      >
        {MODE_OPTS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-zinc-500">{MODE_OPTS.find((o) => o.value === value)?.hint}</p>
    </div>
  )

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-zinc-300">GPU attention backend</p>
        <p className="mt-1 text-xs text-zinc-500">
          Default is <span className="text-zinc-400">Auto</span> — same as the standalone app. Diffusion
          models often run faster with SDPA than forced flash-attn; use Flash only when you want the
          flash-attn wheel explicitly.
        </p>
      </div>
      {modeSelect(
        'gpu-attn-chat',
        'Chat (GGUF / llama.cpp)',
        'omega-engine. Per-model override in Models → settings.',
        chatMode,
        (m) =>
          setAttn({
            chatMode: m,
            chatEnabled: undefined
          })
      )}
      {modeSelect(
        'gpu-attn-cs',
        'Content Studio (TTS & images)',
        'PyTorch / diffusers pipelines. Restart Content Studio after changing this.',
        csMode,
        (m) =>
          setAttn({
            contentStudioMode: m,
            contentStudioEnabled: undefined
          })
      )}
    </div>
  )
}
