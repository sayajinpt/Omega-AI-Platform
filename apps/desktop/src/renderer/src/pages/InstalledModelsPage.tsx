import { useState } from 'react'
import type { ModelInfo, OmegaConfig } from '@omega/sdk'
import { InstalledModelsTab } from '../components/InstalledModelsTab'
import { InputBuilderTab } from '../components/input-pipeline/InputBuilderTab'
import { ModelRolesTab } from '../components/ModelRolesTab'

type TabId = 'installed' | 'builder' | 'roles'

const TABS: { id: TabId; label: string }[] = [
  { id: 'installed', label: 'Installed' },
  { id: 'builder', label: 'Input Builder' },
  { id: 'roles', label: 'Model roles' }
]

export function InstalledModelsPage({
  models,
  config,
  onRefresh,
  onOpenModelStudio
}: {
  models: ModelInfo[]
  config: OmegaConfig
  onRefresh: () => void
  onOpenModelStudio: () => void
}) {
  const [tab, setTab] = useState<TabId>('installed')

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h2 className="text-lg font-semibold">Models</h2>
        <p className="text-sm text-zinc-500">
          Installed models, input pipelines, and model roles · {config.modelsDir}
        </p>
        <nav className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                tab === t.id ? 'bg-zinc-800 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        {tab === 'installed' && (
          <InstalledModelsTab
            models={models}
            defaultModel={config.defaultModel}
            modelsDir={config.modelsDir}
            onRefresh={onRefresh}
            onBrowseHub={onOpenModelStudio}
          />
        )}
        {tab === 'builder' && <InputBuilderTab models={models} />}
        {tab === 'roles' && (
          <ModelRolesTab config={config} models={models} onConfigChanged={onRefresh} />
        )}
      </div>
    </div>
  )
}
