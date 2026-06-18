import { useCallback, useEffect, useState } from 'react'
import { engineClient } from '../lib/engine'

type SidecarStatus = {
  scriptPresent: boolean
  venvPresent: boolean
  pythonPath: string
  venvPath: string
  exl2Installed: boolean
  onnxInstalled: boolean
  exl2ImportOk: boolean
  onnxImportOk: boolean
  installInProgress: boolean
  lastError?: string
  diskHintMb: number
}

export function SidecarEnginesSettings() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [wantExl2, setWantExl2] = useState(true)
  const [wantOnnx, setWantOnnx] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await engineClient.engines.sidecarStatus())
  }, [])

  useEffect(() => {
    void refresh()
    const off = engineClient.engines.onSidecarInstallProgress((e) => {
      setProgress(`${e.phase}: ${e.detail}`)
    })
    return off
  }, [refresh])

  const runInstall = async () => {
    const components: Array<'exl2' | 'onnx'> = []
    if (wantExl2) components.push('exl2')
    if (wantOnnx) components.push('onnx')
    if (!components.length) {
      setError('Select at least one optional engine.')
      return
    }
    setError(null)
    setInstalling(true)
    setProgress('Starting…')
    try {
      await engineClient.engines.installSidecar(components)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  const runUninstall = async () => {
    if (!confirm('Remove the optional EXL2/ONNX Python environment? (~2–3 GB freed)')) return
    setInstalling(true)
    try {
      await engineClient.engines.uninstallSidecar()
      await refresh()
      setProgress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  if (!status) return <p className="text-sm text-zinc-500">Loading optional engines…</p>

  const exl2Ready = status.exl2Installed && status.exl2ImportOk
  const onnxReady = status.onnxInstalled && status.onnxImportOk

  return (
    <div className="space-y-4 text-sm">
      <p className="text-zinc-400">
        Base Omega includes <strong className="text-emerald-300">GGUF</strong> and{' '}
        <strong className="text-sky-300">Ollama</strong> engines. Install these only if you use{' '}
        <strong className="text-violet-300">EXL2</strong> or{' '}
        <strong className="text-fuchsia-300">ONNX GenAI</strong> models from Model Studio (~
        {status.diskHintMb >= 1024
          ? `${(status.diskHintMb / 1024).toFixed(1)} GB`
          : `${status.diskHintMb} MB`}{' '}
        download, not added to the installer).
      </p>

      {!status.scriptPresent && (
        <p className="rounded border border-amber-800/50 bg-amber-950/30 p-2 text-xs text-amber-200">
          Sidecar scripts missing from this install — reinstall Omega or use a full dev build.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <input
            type="checkbox"
            checked={wantExl2}
            disabled={installing}
            onChange={(e) => setWantExl2(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-violet-200">EXL2 (ExLlamaV2)</span>
            <span className="mt-1 block text-xs text-zinc-500">
              NVIDIA GPU + CUDA PyTorch. Status:{' '}
              {exl2Ready ? (
                <span className="text-emerald-400">ready</span>
              ) : status.exl2Installed ? (
                <span className="text-amber-400">installed, import failed</span>
              ) : (
                <span className="text-zinc-500">not installed</span>
              )}
            </span>
          </span>
        </label>

        <label className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <input
            type="checkbox"
            checked={wantOnnx}
            disabled={installing}
            onChange={(e) => setWantOnnx(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-fuchsia-200">ONNX (Runtime GenAI)</span>
            <span className="mt-1 block text-xs text-zinc-500">
              CPU / CUDA / DirectML. Status:{' '}
              {onnxReady ? (
                <span className="text-emerald-400">ready</span>
              ) : status.onnxInstalled ? (
                <span className="text-amber-400">installed, import failed</span>
              ) : (
                <span className="text-zinc-500">not installed</span>
              )}
            </span>
          </span>
        </label>
      </div>

      <p className="text-xs text-zinc-500">
        Requires Python 3.10+ on your PC (from python.org). Installer scripts:{' '}
        <code className="text-zinc-400">{status.venvPath || '~/.omega/venvs/unified'}</code>
      </p>

      {progress && (
        <p className="rounded border border-indigo-900/40 bg-indigo-950/20 p-2 text-xs text-indigo-200">
          {progress}
        </p>
      )}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={installing || !status.scriptPresent}
          onClick={() => void runInstall()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {installing ? 'Installing…' : status.venvPresent ? 'Update selected engines' : 'Install selected engines'}
        </button>
        {status.venvPresent && (
          <button
            type="button"
            disabled={installing}
            onClick={() => void runUninstall()}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Remove optional engines
          </button>
        )}
        <button
          type="button"
          disabled={installing}
          onClick={() => void refresh()}
          className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
        >
          Refresh status
        </button>
      </div>
    </div>
  )
}
