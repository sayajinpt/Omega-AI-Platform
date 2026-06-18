import { useEffect, useState } from 'react'
import type { Profile } from '@omega/sdk'
import type { Page } from '../App'
import { t } from '../i18n'
import { engineClient } from '../lib/engine'

function makeGroups(): { title: string; items: { id: Page; label: string }[] }[] {
  return [
    {
      title: t('group.workspace'),
      items: [
        { id: 'chat', label: t('nav.chat') },
        { id: 'browser', label: t('nav.browser') },
        { id: 'text-editor', label: t('nav.textEditor') },
        { id: 'agent', label: t('nav.agent') },
        { id: 'office', label: 'Office' },
        { id: 'workflows', label: t('nav.workflows') },
        { id: 'kanban', label: t('nav.kanban') },
        { id: 'schedules', label: t('nav.schedules') },
        { id: 'content-studio', label: 'Content Studio' }
      ]
    },
    {
      title: t('group.knowledge'),
      items: [
        { id: 'memory', label: t('nav.memory') },
        { id: 'docs', label: t('nav.docs') },
        { id: 'skills', label: t('nav.skills') },
        { id: 'soul', label: t('nav.soul') }
      ]
    },
    {
      title: t('group.connect'),
      items: [
        { id: 'providers', label: t('nav.providers') },
        { id: 'mcp', label: t('nav.mcp') },
        { id: 'gateway', label: t('nav.gateway') },
        { id: 'plugins', label: t('nav.plugins') }
      ]
    },
    {
      title: t('group.system'),
      items: [
        { id: 'models', label: t('nav.models') },
        { id: 'installed-models', label: t('nav.installedModels') },
        { id: 'finetune', label: t('nav.finetune') },
        { id: 'engines', label: t('nav.engines') ?? 'Engines' },
        { id: 'tools', label: t('nav.tools') },
        { id: 'settings', label: t('nav.settings') },
        { id: 'debug', label: t('nav.debug') }
      ]
    }
  ]
}

export function Sidebar({
  page,
  onNavigate,
  runtimeState,
  activeModel
}: {
  page: Page
  onNavigate: (p: Page) => void
  runtimeState: string
  activeModel?: string
}) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const reload = async () => setProfiles(await engineClient.profiles.list())
  useEffect(() => {
    reload()
  }, [])

  const active = profiles.find((p) => p.isActive)

  return (
    <aside className="flex h-full w-full min-w-0 flex-col bg-zinc-900/80 p-4">
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight text-[var(--omega-accent)]">Ωmega</h1>
        <p className="text-xs text-[var(--omega-text-muted)]">Local AI OS</p>
      </div>

      <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs">
        <p className="mb-1 text-[10px] uppercase text-zinc-500">Profile</p>
        <select
          value={active?.id ?? 'default'}
          onChange={async (e) => {
            await engineClient.profiles.switch(e.target.value)
            reload()
            // Reload window so per-profile services reattach to new files
            window.location.reload()
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
        {creating ? (
          <div className="mt-1 flex gap-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new profile"
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px]"
            />
            <button
              type="button"
              onClick={async () => {
                if (!newName.trim()) return
                try {
                  await engineClient.profiles.create(newName.trim())
                  await reload()
                } finally {
                  setNewName('')
                  setCreating(false)
                }
              }}
              className="rounded bg-indigo-600 px-1.5 text-[10px]"
            >
              ok
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setNewName('')
              }}
              className="rounded bg-zinc-800 px-1.5 text-[10px]"
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-1 text-[10px] text-zinc-400 hover:text-indigo-300"
          >
            + new profile
          </button>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {makeGroups().map((group) => (
          <div key={group.title}>
            <p className="mb-1 px-3 text-[10px] uppercase tracking-wider text-zinc-600">{group.title}</p>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${
                  page === item.id ? 'bg-indigo-600/30 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-4 space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs">
        <div>
          <span className="text-zinc-500">Runtime </span>
          <span className={runtimeState === 'ready' ? 'text-emerald-400' : 'text-amber-400'}>
            {runtimeState}
          </span>
        </div>
        {activeModel && (
          <div className="truncate text-zinc-500">
            <span className="text-zinc-500">Model </span>
            <span className="text-indigo-300">{activeModel}</span>
          </div>
        )}
      </div>
    </aside>
  )
}
