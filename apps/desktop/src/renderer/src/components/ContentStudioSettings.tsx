import { useCallback, useEffect, useState } from 'react'
import type { ContentStudioCredentials } from '@omega/sdk'
import { CollapsibleSection } from './CollapsibleSection'
import { engineClient } from '../lib/engine'

const emptyCreds = (): ContentStudioCredentials => ({
  youtubeUploadPrivacy: 'private',
  youtubeOAuthRedirectUri: 'http://127.0.0.1:8765/oauth2callback'
})

function mergeCreds(raw: ContentStudioCredentials | null | undefined): ContentStudioCredentials {
  return { ...emptyCreds(), ...(raw && typeof raw === 'object' ? raw : {}) }
}

function Field({
  label,
  value,
  onChange,
  secret = false,
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  secret?: boolean
  placeholder?: string
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-400">{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

export function ContentStudioSettings() {
  const [creds, setCreds] = useState<ContentStudioCredentials>(emptyCreds())
  const [platformStatus, setPlatformStatus] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setCreds(mergeCreds(await engineClient.contentStudio.credentials.get()))
    } catch {
      setCreds(emptyCreds())
    }
    try {
      setPlatformStatus(await engineClient.contentStudio.credentials.status())
    } catch {
      setPlatformStatus({})
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await engineClient.contentStudio.credentials.set(creds)
      setPlatformStatus(await engineClient.contentStudio.credentials.status())
      setMsg('Credentials saved and synced to Content Studio API.')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const connectYoutube = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await engineClient.contentStudio.credentials.set(creds)
      const { refreshToken } = await engineClient.contentStudio.youtube.connect()
      setCreds(mergeCreds(await engineClient.contentStudio.credentials.get()))
      setPlatformStatus(await engineClient.contentStudio.credentials.status())
      setMsg(refreshToken ? 'YouTube connected (refresh token stored).' : 'YouTube connected.')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const patch = (p: Partial<ContentStudioCredentials>) =>
    setCreds((c) => ({ ...emptyCreds(), ...c, ...p }))

  return (
    <CollapsibleSection title="Content Studio (Media Automation APIs)" defaultOpen={false}>
      <p className="mb-3 text-xs text-zinc-500">
        API keys are stored locally in your Omega profile and pushed to the Content Studio backend
        when it runs. Add the same redirect URI in Google Cloud:{' '}
        <code className="text-indigo-300">
          {creds.youtubeOAuthRedirectUri || 'http://127.0.0.1:8765/oauth2callback'}
        </code>
      </p>
      {msg && <p className="mb-2 text-sm text-indigo-300">{msg}</p>}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {Object.entries(platformStatus).map(([p, ok]) => (
          <span
            key={p}
            className={`rounded px-2 py-0.5 ${ok ? 'bg-emerald-900/40 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}
          >
            {p}: {ok ? 'ready' : 'missing keys'}
          </span>
        ))}
      </div>

      <h4 className="mb-2 text-sm font-medium text-zinc-300">YouTube</h4>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Field label="Client ID" value={creds.youtubeClientId ?? ''} onChange={(v) => patch({ youtubeClientId: v })} />
        <Field
          label="Client secret"
          value={creds.youtubeClientSecret ?? ''}
          onChange={(v) => patch({ youtubeClientSecret: v })}
          secret
        />
        <Field
          label="Refresh token (or use Connect)"
          value={creds.youtubeRefreshToken ?? ''}
          onChange={(v) => patch({ youtubeRefreshToken: v })}
          secret
        />
        <label className="block text-sm">
          <span className="text-zinc-400">Upload privacy</span>
          <select
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
            value={creds.youtubeUploadPrivacy ?? 'private'}
            onChange={(e) =>
              patch({ youtubeUploadPrivacy: e.target.value as ContentStudioCredentials['youtubeUploadPrivacy'] })
            }
          >
            <option value="private">private</option>
            <option value="unlisted">unlisted</option>
            <option value="public">public</option>
          </select>
        </label>
        <Field
          label="OAuth redirect URI"
          value={creds.youtubeOAuthRedirectUri ?? ''}
          onChange={(v) => patch({ youtubeOAuthRedirectUri: v })}
          placeholder="http://127.0.0.1:8765/oauth2callback"
        />
      </div>
      <button
        type="button"
        className="mb-6 rounded border border-red-800/50 bg-red-950/30 px-3 py-1.5 text-sm text-red-200"
        onClick={() => void connectYoutube()}
        disabled={busy}
      >
        Connect YouTube (browser OAuth)
      </button>

      <h4 className="mb-2 text-sm font-medium text-zinc-300">Meta (Instagram / Facebook)</h4>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Field label="App ID" value={creds.metaAppId ?? ''} onChange={(v) => patch({ metaAppId: v })} />
        <Field label="App secret" value={creds.metaAppSecret ?? ''} onChange={(v) => patch({ metaAppSecret: v })} secret />
        <Field label="Page access token" value={creds.metaAccessToken ?? ''} onChange={(v) => patch({ metaAccessToken: v })} secret />
        <Field label="Facebook Page ID" value={creds.metaPageId ?? ''} onChange={(v) => patch({ metaPageId: v })} />
        <Field
          label="Instagram Business account ID"
          value={creds.instagramBusinessAccountId ?? ''}
          onChange={(v) => patch({ instagramBusinessAccountId: v })}
        />
      </div>

      <h4 className="mb-2 text-sm font-medium text-zinc-300">TikTok</h4>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Field label="Client key" value={creds.tiktokClientKey ?? ''} onChange={(v) => patch({ tiktokClientKey: v })} />
        <Field label="Client secret" value={creds.tiktokClientSecret ?? ''} onChange={(v) => patch({ tiktokClientSecret: v })} secret />
        <Field label="Access token" value={creds.tiktokAccessToken ?? ''} onChange={(v) => patch({ tiktokAccessToken: v })} secret />
      </div>

      <h4 className="mb-2 text-sm font-medium text-zinc-300">X (Twitter)</h4>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Field label="API key" value={creds.xApiKey ?? ''} onChange={(v) => patch({ xApiKey: v })} />
        <Field label="API secret" value={creds.xApiSecret ?? ''} onChange={(v) => patch({ xApiSecret: v })} secret />
        <Field label="Access token" value={creds.xAccessToken ?? ''} onChange={(v) => patch({ xAccessToken: v })} secret />
        <Field
          label="Access token secret"
          value={creds.xAccessTokenSecret ?? ''}
          onChange={(v) => patch({ xAccessTokenSecret: v })}
          secret
        />
      </div>

      <h4 className="mb-2 text-sm font-medium text-zinc-300">LinkedIn</h4>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Field label="Client ID" value={creds.linkedinClientId ?? ''} onChange={(v) => patch({ linkedinClientId: v })} />
        <Field label="Client secret" value={creds.linkedinClientSecret ?? ''} onChange={(v) => patch({ linkedinClientSecret: v })} secret />
        <Field label="Access token" value={creds.linkedinAccessToken ?? ''} onChange={(v) => patch({ linkedinAccessToken: v })} secret />
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        {busy ? 'Savingù' : 'Save & sync credentials'}
      </button>
    </CollapsibleSection>
  )
}
