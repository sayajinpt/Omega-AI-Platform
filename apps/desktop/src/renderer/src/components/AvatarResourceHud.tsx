import { useEffect, useState } from 'react'
import type { HardwareTelemetry } from '@omega/sdk'
import { engineClient } from '../lib/engine'

export type AvatarResourceSnapshot = {
  telemetry: HardwareTelemetry | null
  runtime: { state: string; error?: string; inference?: string; activeModel?: string } | null
  loadedModels: string[]
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

function pct(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function barColor(pressure: number): string {
  if (pressure >= 0.92) return '#f87171'
  if (pressure >= 0.78) return '#fbbf24'
  return '#34d399'
}

function ResourceMeter({
  label,
  usedMb,
  totalMb,
  sublabel,
  compact,
  uiScale
}: {
  label: string
  usedMb: number
  totalMb: number
  sublabel?: string
  compact?: boolean
  uiScale: number
}) {
  const freeMb = Math.max(0, totalMb - usedMb)
  const pressure = totalMb > 0 ? usedMb / totalMb : 0
  const p = pct(usedMb, totalMb)
  const fontPx = Math.max(7, Math.round((compact ? 8 : 9) * uiScale))
  const barH = Math.max(3, Math.round((compact ? 4 : 6) * uiScale))
  return (
    <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
      <div className="flex items-center justify-between gap-1" style={{ fontSize: fontPx }}>
        <span className="truncate text-zinc-400">{label}</span>
        <span className="shrink-0 tabular-nums text-zinc-500">
          {p}% · {fmtMb(freeMb)} free
        </span>
      </div>
      <div className="overflow-hidden rounded-full bg-zinc-800/90" style={{ height: barH }}>
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${p}%`, backgroundColor: barColor(pressure) }}
        />
      </div>
      {sublabel && !compact && (
        <p className="truncate text-zinc-600" style={{ fontSize: Math.max(7, Math.round(8 * uiScale)) }}>
          {sublabel}
        </p>
      )}
    </div>
  )
}

export function useAvatarResources(pollMs = 2500): AvatarResourceSnapshot | null {
  const [snap, setSnap] = useState<AvatarResourceSnapshot | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const [runtime, loaded] = await Promise.all([
        engineClient.runtime.status().catch(() => null),
        engineClient.runtime.loadedModels().catch(() => [] as string[])
      ])
      setSnap({ telemetry: null, runtime, loadedModels: loaded })
    }
    void load()
    const t = setInterval(() => void load(), pollMs)
    return () => clearInterval(t)
  }, [pollMs])

  return snap
}

export function AvatarResourceHud({
  snap,
  compact = false,
  uiScale = 1
}: {
  snap: AvatarResourceSnapshot | null
  compact?: boolean
  uiScale?: number
}) {
  const baseFont = Math.max(7, Math.round((compact ? 8 : 9) * uiScale))
  const chipPadX = Math.max(4, Math.round(6 * uiScale))
  const chipPadY = Math.max(2, Math.round(2 * uiScale))

  if (!snap) {
    return <p className="text-zinc-600" style={{ fontSize: baseFont }}>Loading resources…</p>
  }

  const { telemetry, runtime, loadedModels } = snap
  const gpus = telemetry?.gpus.filter((g) => g.vramTotalMb > 0) ?? []
  const primaryGpu = gpus[0]
  const vramUsed = gpus.reduce((a, g) => a + g.vramUsedMb, 0)
  const vramTotal = gpus.reduce((a, g) => a + g.vramTotalMb, 0)
  const ram = telemetry?.ram
  const cpuLoad = telemetry?.cpu.loadAvg[0]

  const chipStyle = { fontSize: baseFont, padding: `${chipPadY}px ${chipPadX}px` }

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'} style={{ fontSize: baseFont }}>
      <div className="flex flex-wrap gap-1">
        <span className="rounded bg-zinc-800/80 text-zinc-400" style={chipStyle}>
          {runtime?.state ?? '—'}
        </span>
        {runtime?.inference && (
          <span className="rounded bg-indigo-950/80 text-indigo-300/90" style={chipStyle}>
            {runtime.inference}
          </span>
        )}
        {loadedModels.length > 0 && (
          <span className="rounded bg-emerald-950/50 text-emerald-300/90" style={chipStyle}>
            {loadedModels.length} loaded
          </span>
        )}
      </div>

      {runtime?.activeModel && (
        <p className="truncate text-indigo-300/90" style={{ fontSize: baseFont }} title={runtime.activeModel}>
          Model: {runtime.activeModel}
        </p>
      )}

      {ram && (
        <ResourceMeter
          label="System RAM"
          usedMb={ram.usedMb}
          totalMb={ram.totalMb}
          sublabel={telemetry?.cpu.model ? `CPU · ${telemetry.cpu.cores} cores` : undefined}
          compact={compact}
          uiScale={uiScale}
        />
      )}

      {vramTotal > 0 ? (
        <ResourceMeter
          label={gpus.length > 1 ? `VRAM (${gpus.length} GPUs)` : (primaryGpu?.name ?? 'VRAM')}
          usedMb={vramUsed}
          totalMb={vramTotal}
          sublabel={
            primaryGpu?.utilizationPct !== undefined
              ? `GPU ${primaryGpu.utilizationPct}%${primaryGpu.temperatureC != null ? ` · ${primaryGpu.temperatureC}°C` : ''}`
              : undefined
          }
          compact={compact}
          uiScale={uiScale}
        />
      ) : (
        ram && (
          <p className="text-zinc-600" style={{ fontSize: baseFont }}>
            No discrete GPU telemetry
          </p>
        )
      )}

      {cpuLoad !== undefined && cpuLoad > 0.01 && (
        <p className="tabular-nums text-zinc-600" style={{ fontSize: baseFont }}>
          CPU load (1m): {(cpuLoad * 100).toFixed(0)}%
        </p>
      )}

      {runtime?.error && (
        <p className="text-rose-400/90" style={{ fontSize: baseFont }}>
          {runtime.error}
        </p>
      )}
    </div>
  )
}
