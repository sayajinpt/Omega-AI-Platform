import { useEffect, useMemo, useState } from 'react'
import type { ContentStudioKind, HFFile } from '@omega/sdk'
import {
  chatQuantPresets,
  estimateContentStudioSnapshotBytes,
  fileRole,
  inferContentStudioKind,
  inferOnnxRepoKind,
  isContentStudioSnapshotRepo,
  isOnnxGenaiChatRepo,
  isVisionModelRepo,
  pickPrimaryGenaiConfigPath,
  pickPrimaryGgufFile,
  pickVisionProjectorFile,
  resolveOnnxGenaiPaths,
  resolveReadyGgufPaths,
  effectiveFileSizeBytes,
  formatFileGiB,
  sumFileBytes
} from '@omega/sdk'
import { engineClient } from '../lib/engine'

function FileRowCompact({
  file,
  files,
  gpuTotalMb,
  onDownload,
  roleLabel,
  showFullPath
}: {
  file: HFFile
  files: HFFile[]
  gpuTotalMb: number
  onDownload: () => void
  roleLabel?: string
  showFullPath?: boolean
}) {
  const [est, setEst] = useState<{ vramMb: number } | null>(null)
  useEffect(() => {
    if (!file.nativeSupported) return
    let cancel = false
    engineClient.modelMeta
      .estimateFile(effectiveFileSizeBytes(file, files), 4096, file.quant)
      .then((e) => !cancel && setEst({ vramMb: e.vramMb }))
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [file, files, file.quant, file.nativeSupported])

  const fitGpu = est && gpuTotalMb > 0 ? est.vramMb <= gpuTotalMb : null
  const fmt = (mb: number): string => (mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(2)} GB`)

  return (
    <li className="flex items-center justify-between gap-2 rounded bg-zinc-950/80 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11px] text-zinc-300" title={file.path}>
          {showFullPath ? file.path : file.path.split('/').pop()}
        </p>
        <p className="text-[10px] text-zinc-500">
          {roleLabel ? `${roleLabel} · ` : ''}
          {formatFileGiB(effectiveFileSizeBytes(file, files))}
          {file.quant ? ` · ${file.quant}` : ''}
          {est && gpuTotalMb > 0 && (
            <>
              {' '}
              · GPU ~{fmt(est.vramMb)}
              {fitGpu === false && ' (hybrid offload likely)'}
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onDownload}
        className="shrink-0 rounded bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-600"
        title="Download only this file (advanced)"
      >
        This file
      </button>
    </li>
  )
}

export function ModelRepoFilesPanel({
  repoId,
  files,
  allFiles,
  tags,
  busy,
  gpuTotalMb,
  filteredCount,
  totalCount,
  onDownloadFile,
  onDownloadReady,
  onDownloadOnnxReady,
  onDownloadGenerationSnapshot,
  generationInstalled,
  pipeline
}: {
  repoId: string
  files: HFFile[]
  /** Unfiltered repo listing — used for Content Studio snapshot detection when filters hide weight files. */
  allFiles?: HFFile[]
  tags: string[]
  busy: boolean
  gpuTotalMb: number
  filteredCount: number
  totalCount: number
  onDownloadFile: (path: string) => void
  onDownloadReady: (chatPath: string, visionPath?: string) => void
  onDownloadOnnxReady?: () => void
  onDownloadGenerationSnapshot?: (kind: ContentStudioKind, sizeHint: string) => void
  generationInstalled?: { tts: boolean; image: boolean; video: boolean }
  pipeline?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const [snapshotKind, setSnapshotKind] = useState<ContentStudioKind>(() =>
    inferContentStudioKind(repoId, tags, pipeline)
  )
  const visionRepo = isVisionModelRepo(repoId, tags)
  const catalogFiles = allFiles ?? files
  const onnxGenaiRepo = isOnnxGenaiChatRepo(catalogFiles, tags, pipeline, repoId)
  const onnxRepoKind = inferOnnxRepoKind(catalogFiles, tags, pipeline, repoId)
  const onnxCommunityHybridWarning =
    onnxGenaiRepo &&
    !catalogFiles.some((f) => (f.path.split(/[/\\]/).pop() ?? f.path).toLowerCase() === 'genai_config.json') &&
    /onnx-community|qwen3[\._-]?5/i.test(`${repoId} ${tags.join(' ')}`)
  const snapshotRepo = isContentStudioSnapshotRepo(catalogFiles, tags, pipeline, repoId)
  const presets = useMemo(() => chatQuantPresets(files), [files])
  const defaultChat = pickPrimaryGgufFile(files)
  const defaultVision = pickVisionProjectorFile(files, defaultChat?.path ?? null)
  const onnxPaths = useMemo(() => resolveOnnxGenaiPaths(catalogFiles), [catalogFiles])
  const onnxGb = sumFileBytes(catalogFiles, onnxPaths) / 1024 ** 3
  const nestedGenaiPackDir = useMemo(() => {
    const cfg = pickPrimaryGenaiConfigPath(catalogFiles)
    if (!cfg) return null
    const slash = Math.max(cfg.lastIndexOf('/'), cfg.lastIndexOf('\\'))
    return slash >= 0 ? cfg.slice(0, slash) : null
  }, [catalogFiles])

  const [chatPath, setChatPath] = useState<string | null>(null)
  const [visionPath, setVisionPath] = useState<string | null>(null)

  const activeChatPath = chatPath ?? defaultChat?.path ?? null
  const activeVisionPath =
    visionPath ?? (visionRepo ? pickVisionProjectorFile(files, activeChatPath)?.path : null)

  const readyPaths = useMemo(
    () =>
      activeChatPath
        ? resolveReadyGgufPaths(repoId, files, {
            chatPath: activeChatPath,
            visionPath: activeVisionPath ?? undefined,
            tags
          })
        : [],
    [repoId, files, activeChatPath, activeVisionPath, tags]
  )

  const readyGb = sumFileBytes(files, readyPaths) / 1024 ** 3
  const chatFiles = files.filter((f) => fileRole(f, repoId, tags) === 'chat')
  const visionFiles = files.filter((f) => fileRole(f, repoId, tags) === 'vision')
  const otherFiles = files.filter((f) => {
    const r = fileRole(f, repoId, tags)
    return r === 'shard' || r === 'other'
  })

  const fileCountLabel =
    filteredCount !== totalCount ? `${filteredCount} of ${totalCount}` : String(filteredCount)
  const snapshotGb = estimateContentStudioSnapshotBytes(catalogFiles) / 1024 ** 3
  const snapshotSizeHint = `~${snapshotGb.toFixed(1)} GB`
  const snapshotInstalled =
    snapshotKind === 'tts'
      ? generationInstalled?.tts
      : snapshotKind === 'video'
        ? generationInstalled?.video
        : generationInstalled?.image
  const snapshotRoleLabel =
    snapshotKind === 'tts' ? 'TTS' : snapshotKind === 'video' ? 'video' : 'image'

  useEffect(() => {
    setSnapshotKind(inferContentStudioKind(repoId, tags, pipeline))
  }, [repoId, tags, pipeline])

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-indigo-900/50 bg-indigo-950/30 p-3 text-xs text-indigo-100/90">
        <p className="font-medium text-indigo-200">One model, many files on HuggingFace</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-indigo-100/80">
          {defaultChat ? (
            <>
              <li>
                Each row is <strong>one file</strong>, not a separate model. You do <strong>not</strong> need every
                download.
              </li>
              <li>
                Pick <strong>one chat .gguf</strong> (quantization = size vs quality). That single file is the full
                language model.
              </li>
              {visionRepo && (
                <li>
                  For images: also pick <strong>one mmproj</strong> file (we default to F16).
                </li>
              )}
              <li>
                Names like <span className="font-mono">00001-of-00002</span> are shards of one variant — get all parts
                of that variant only.
              </li>
            </>
          ) : onnxGenaiRepo ? (
            <>
              <li>
                This repo ships an <strong>ONNX Runtime GenAI</strong> chat model — not a GGUF or diffusion snapshot.
              </li>
              <li>
                Use <strong>Download ONNX chat pack</strong> to pull weights, tokenizer, and{' '}
                <span className="font-mono">genai_config.json</span> into{' '}
                <span className="font-mono">~/.omega/models/</span>.
              </li>
              <li>
                After download, load it from <strong>Installed</strong> like any chat model (requires ONNX sidecar in
                Settings → Performance).
              </li>
              {onnxCommunityHybridWarning ? (
                <li className="text-amber-200/90">
                  <strong>Qwen3.5 onnx-community packs</strong> use a transformers.js ONNX layout; Omega runs these via
                  a direct ONNX Runtime path (not GenAI). First load may take a few seconds while weights mmap in.
                </li>
              ) : null}
            </>
          ) : onnxRepoKind === 'vision_encoder' ? (
            <>
              <li>
                This repo is a <strong>vision ONNX encoder</strong> (DINOv, SigLIP, etc.) — not a chat LLM.
              </li>
              <li>
                HF pipeline: <span className="font-mono">{pipeline || 'image-feature-extraction'}</span>. Use{' '}
                <strong>Download snapshot</strong> for Content Studio or custom vision pipelines.
              </li>
            </>
          ) : onnxRepoKind === 'embedding' ? (
            <>
              <li>
                This repo is an <strong>embedding / reranker ONNX</strong> model — not for Omega chat.
              </li>
              <li>
                HF pipeline: <span className="font-mono">{pipeline || 'feature-extraction'}</span>. Download if you
                need it for retrieval or RAG tooling.
              </li>
            </>
          ) : onnxRepoKind === 'speech' ? (
            <>
              <li>
                This repo is a <strong>speech ONNX</strong> model (TTS or ASR) — not for text chat.
              </li>
              <li>
                Use <strong>Download snapshot</strong> and assign under Settings → Model roles (TTS).
              </li>
            </>
          ) : onnxRepoKind === 'multimodal' ? (
            <>
              <li>
                This repo is a <strong>multimodal ONNX</strong> model (vision + language). Omega sidecar text chat
                is not available for this layout yet.
              </li>
              <li>
                Use <strong>Download snapshot</strong> for Content Studio or future multimodal support.
              </li>
            </>
          ) : snapshotRepo ? (
            <>
              <li>
                This repo ships <strong>generation weights</strong> (TTS, image, or video), not a chat GGUF.
              </li>
              <li>
                The file list below shows <strong>weight files only</strong> (safetensors / GGUF). Configs,
                README, and media from Hugging Face are still included in <strong>Download snapshot</strong>.
              </li>
              <li>
                Paths like <span className="font-mono">transformer/…</span> match Hugging Face subfolders — we
                show the full path in the list.
              </li>
              <li>
                Use <strong>Download snapshot</strong> — Omega pulls the full repo into{' '}
                <span className="font-mono">~/.omega/models/generation-models/</span>.
              </li>
              <li>
                After download, assign it in <strong>Settings → Model roles</strong> (TTS, image, or text-to-video).
              </li>
            </>
          ) : (
            <>
              <li>
                Each row is <strong>one file</strong>, not a separate model. You do <strong>not</strong> need every
                download.
              </li>
              <li>
                For chat, pick <strong>one .gguf</strong> quant. For Content Studio weights, look for safetensors /
                diffusers layouts.
              </li>
            </>
          )}
        </ul>
      </div>

      {defaultChat && (
        <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-emerald-100">Download ready to run</p>
              <p className="mt-0.5 text-[11px] text-emerald-200/70">
                {readyPaths.length} file{readyPaths.length !== 1 ? 's' : ''} · ~{readyGb.toFixed(1)} GB total
                {visionRepo && ' (chat + vision)'}
              </p>
            </div>
            <button
              type="button"
              disabled={busy || !activeChatPath}
              onClick={() =>
                activeChatPath && onDownloadReady(activeChatPath, activeVisionPath ?? undefined)
              }
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Download set
            </button>
          </div>

          <p className="mt-3 text-[10px] uppercase tracking-wide text-zinc-500">Chat weights (pick one)</p>
          <ul className="mt-1 space-y-1">
            {presets.map((p) => (
              <li key={p.file.path}>
                <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-zinc-900/60">
                  <input
                    type="radio"
                    name="chat-quant"
                    className="mt-1"
                    checked={activeChatPath === p.file.path}
                    onChange={() => setChatPath(p.file.path)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-zinc-200">{p.label}</span>
                    <span className="ml-2 font-mono text-[10px] text-zinc-500">
                      {formatFileGiB(effectiveFileSizeBytes(p.file, files), 1)}
                      {p.file.quant ? ` · ${p.file.quant}` : ''}
                    </span>
                    <span className="block text-[10px] text-zinc-500">{p.hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {visionRepo && visionFiles.length > 0 && (
            <>
              <p className="mt-3 text-[10px] uppercase tracking-wide text-zinc-500">
                Vision projector (pick one)
              </p>
              <ul className="mt-1 space-y-1">
                {visionFiles.map((f) => (
                  <li key={f.path}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-zinc-900/60">
                      <input
                        type="radio"
                        name="vision-mmproj"
                        checked={activeVisionPath === f.path}
                        onChange={() => setVisionPath(f.path)}
                      />
                      <span className="truncate font-mono text-[11px] text-zinc-300">
                        {f.path.split('/').pop()}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {formatFileGiB(effectiveFileSizeBytes(f, files))}
                      </span>
                      {f.path === defaultVision?.path && (
                        <span className="rounded bg-emerald-800/40 px-1 text-[9px] text-emerald-200">
                          default
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-2 font-mono text-[10px] text-zinc-600">
            {readyPaths.map((p) => p.split('/').pop()).join(' + ')}
          </p>
        </div>
      )}

      {onnxGenaiRepo && onDownloadOnnxReady && (
        <div className="rounded-lg border border-fuchsia-900/40 bg-fuchsia-950/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-fuchsia-100">Download ONNX chat pack</p>
              <p className="mt-0.5 text-[11px] text-fuchsia-200/70">
                {onnxPaths.length} file{onnxPaths.length !== 1 ? 's' : ''} · ~{onnxGb.toFixed(1)} GB · ONNX Runtime
                GenAI sidecar
              </p>
            </div>
            <button
              type="button"
              disabled={busy || onnxPaths.length === 0}
              onClick={() => onDownloadOnnxReady()}
              className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:opacity-40"
            >
              Download pack
            </button>
          </div>
          <p className="mt-2 font-mono text-[10px] text-zinc-600">
            Includes genai_config.json, .onnx weights, and tokenizer files
            {nestedGenaiPackDir ? (
              <>
                {' '}
                · default pack: <span className="text-fuchsia-200/80">{nestedGenaiPackDir}</span>
              </>
            ) : null}
          </p>
        </div>
      )}

      {filteredCount === 0 && totalCount > 0 && (
        <p className="text-xs text-amber-200/90">
          No files match your size/quant filters, but this repo can still be downloaded as a Content Studio
          snapshot below.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs uppercase text-zinc-500">All files ({fileCountLabel})</h4>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-indigo-400 hover:underline"
        >
          {showAll ? 'Hide list' : `Show all ${filteredCount} files`}
        </button>
      </div>

      {showAll && (
        <div className="space-y-3">
          {chatFiles.length > 0 && (
            <section>
              <p className="mb-1 text-[10px] font-medium uppercase text-zinc-500">
                Chat weights — other quants ({chatFiles.length})
              </p>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {chatFiles.map((f) => (
                  <FileRowCompact
                    key={f.path}
                    file={f}
                    files={files}
                    gpuTotalMb={gpuTotalMb}
                    roleLabel="Chat"
                    onDownload={() => onDownloadFile(f.path)}
                    showFullPath={snapshotRepo}
                  />
                ))}
              </ul>
            </section>
          )}
          {visionFiles.length > 0 && (
            <section>
              <p className="mb-1 text-[10px] font-medium uppercase text-zinc-500">
                Vision projectors ({visionFiles.length})
              </p>
              <ul className="space-y-1">
                {visionFiles.map((f) => (
                  <FileRowCompact
                    key={f.path}
                    file={f}
                    files={files}
                    gpuTotalMb={gpuTotalMb}
                    roleLabel="Vision"
                    onDownload={() => onDownloadFile(f.path)}
                    showFullPath={snapshotRepo}
                  />
                ))}
              </ul>
            </section>
          )}
          {otherFiles.length > 0 && (
            <section>
              <p className="mb-1 text-[10px] font-medium uppercase text-zinc-500">Other</p>
              <ul className="space-y-1">
                {otherFiles.map((f) => (
                  <FileRowCompact
                    key={f.path}
                    file={f}
                    files={files}
                    gpuTotalMb={gpuTotalMb}
                    onDownload={() => onDownloadFile(f.path)}
                    showFullPath={snapshotRepo}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {snapshotRepo && onDownloadGenerationSnapshot && (
        <div className="rounded-lg border border-violet-900/40 bg-violet-950/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-violet-100">Download for Content Studio</p>
              <p className="mt-0.5 text-[11px] text-violet-200/70">
                Full repo snapshot · ~{snapshotGb.toFixed(1)} GB · progress in Download queue as
                &quot;(Content Studio snapshot)&quot;
              </p>
              {snapshotInstalled && (
                <p className="mt-1 text-[10px] text-emerald-400/90">
                  Already installed under {snapshotRoleLabel} — you can assign it in Model roles.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                Role
                <select
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  value={snapshotKind}
                  onChange={(e) => setSnapshotKind(e.target.value as ContentStudioKind)}
                >
                  <option value="image">Image generation</option>
                  <option value="video">Text-to-video</option>
                  <option value="tts">Text-to-speech</option>
                </select>
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDownloadGenerationSnapshot(snapshotKind, snapshotSizeHint)}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
              >
                {snapshotInstalled ? 'Re-download snapshot' : 'Download snapshot'}
              </button>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-zinc-500">
            Saves to{' '}
            <span className="font-mono text-zinc-600">
              generation-models/{snapshotKind}/Org__Repo
            </span>
            . Not used for chat — configure it under Settings → Model roles after download.
          </p>
        </div>
      )}

      {!defaultChat && !snapshotRepo && !onnxGenaiRepo && !onnxRepoKind && files.length > 0 && (
        <p className="text-xs text-amber-200/90">
          No runnable GGUF or ONNX GenAI chat pack in this list. Try another repo or format, or use a Content Studio
          weights repo (safetensors / diffusers).
        </p>
      )}
    </div>
  )
}
