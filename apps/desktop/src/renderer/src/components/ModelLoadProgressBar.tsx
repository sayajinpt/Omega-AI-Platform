export function ModelLoadProgressBar({
  percent,
  label,
  active
}: {
  percent: number
  label: string
  active: boolean
}) {
  if (!active) return null
  const pct = Math.min(100, Math.max(0, Math.round(percent)))
  return (
    <div className="w-full min-w-[200px] max-w-md">
      <div className="mb-1 flex justify-between gap-2 text-xs text-zinc-400">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-amber-300">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-emerald-500 transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
