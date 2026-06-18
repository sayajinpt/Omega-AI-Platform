import type { MessagePart } from '@omega/sdk'

export type ContentStudioPart = Extract<MessagePart, { type: 'content_studio' }>
export type DirectVideoPart = Extract<MessagePart, { type: 'direct_video' }>
export type YoutubePart = Extract<MessagePart, { type: 'youtube' }>

export function youtubePartKey(part: YoutubePart): string {
  return [part.watchUrl ?? '', part.embedUrl ?? '', part.title ?? ''].join('|')
}

/** Replace an existing YouTube card for the same watch/embed URL, or append. */
export function upsertYoutubePart(parts: MessagePart[], part: YoutubePart): MessagePart[] {
  const key = youtubePartKey(part)
  const idx = parts.findIndex((p) => p.type === 'youtube' && youtubePartKey(p) === key)
  if (idx < 0) {
    const anyIdx = parts.findIndex((p) => p.type === 'youtube')
    if (anyIdx >= 0) {
      const next = [...parts]
      next[anyIdx] = part
      return next
    }
    return [...parts, part]
  }
  const next = [...parts]
  next[idx] = part
  return next
}

export function contentStudioPartFingerprint(part: ContentStudioPart): string {
  return [
    part.jobId,
    part.projectId,
    part.status,
    part.title ?? '',
    part.videoRef ?? '',
    part.youtubeUrl ?? ''
  ].join('|')
}

/** Replace an existing Content Studio card for the same job, or append. */
export function upsertContentStudioPart(parts: MessagePart[], part: ContentStudioPart): MessagePart[] {
  const idx = parts.findIndex((p) => p.type === 'content_studio' && p.jobId === part.jobId)
  if (idx < 0) return [...parts, part]
  const next = [...parts]
  next[idx] = part
  return next
}

/** Replace an existing direct T2V card for the same job, or append. */
export function upsertDirectVideoPart(parts: MessagePart[], part: DirectVideoPart): MessagePart[] {
  const idx = parts.findIndex((p) => p.type === 'direct_video' && p.jobId === part.jobId)
  if (idx < 0) return [...parts, part]
  const next = [...parts]
  next[idx] = part
  return next
}

/** Merge runtime assistantPatch parts into an existing message (preserve non-job parts). */
export function mergeAssistantPatchParts(
  existing: MessagePart[] | undefined,
  patch: MessagePart[]
): MessagePart[] {
  let out = existing?.length ? [...existing] : []
  for (const p of patch) {
    if (p.type === 'direct_video') out = upsertDirectVideoPart(out, p)
    else if (p.type === 'content_studio') out = upsertContentStudioPart(out, p)
    else if (p.type === 'youtube') out = upsertYoutubePart(out, p)
    else if (p.type === 'video' || p.type === 'audio' || p.type === 'image') {
      const key = `${p.type}:${p.ref}`
      const idx = out.findIndex((x) => (x.type === 'video' || x.type === 'audio' || x.type === 'image') && `${x.type}:${x.ref}` === key)
      if (idx >= 0) out[idx] = p
      else out.push(p)
    } else if (p.type === 'text') {
      const incoming = (p.text ?? '').trim()
      if (!incoming) continue
      const isCodeFence = incoming.includes('```')
      if (!isCodeFence) {
        // Streaming prose or a fresh summary — replace prior plain-text parts, keep code fences.
        out = out.filter((x) => x.type !== 'text' || (x.text ?? '').includes('```'))
      }
      out.push(p)
    } else {
      out.push(p)
    }
  }
  return dedupeMessageParts(out)
}

export function dedupeContentStudioParts(parts: MessagePart[]): MessagePart[] {
  const out: MessagePart[] = []
  const byJob = new Map<string, number>()
  for (const p of parts) {
    if (p.type !== 'content_studio') {
      out.push(p)
      continue
    }
    const prev = byJob.get(p.jobId)
    if (prev === undefined) {
      byJob.set(p.jobId, out.length)
      out.push(p)
    } else {
      out[prev] = p
    }
  }
  return out
}

function choicesPromptKey(part: Extract<MessagePart, { type: 'choices' }>): string {
  return (part.prompt ?? '').trim().toLowerCase()
}

/** One inline player per media ref; one Content Studio card per job; one choices card per prompt. */
export function dedupeMessageParts(parts: MessagePart[]): MessagePart[] {
  const out: MessagePart[] = []
  const csByJob = new Map<string, number>()
  const dvByJob = new Map<string, number>()
  const youtubeByKey = new Map<string, number>()
  const mediaByRef = new Map<string, number>()
  const choicesByPrompt = new Map<string, number>()
  for (const p of parts) {
    if (p.type === 'content_studio') {
      const prev = csByJob.get(p.jobId)
      if (prev === undefined) {
        csByJob.set(p.jobId, out.length)
        out.push(p)
      } else {
        out[prev] = p
      }
      continue
    }
    if (p.type === 'direct_video') {
      const prev = dvByJob.get(p.jobId)
      if (prev === undefined) {
        dvByJob.set(p.jobId, out.length)
        out.push(p)
      } else {
        out[prev] = p
      }
      continue
    }
    if (p.type === 'youtube') {
      const key = youtubePartKey(p)
      const prev = youtubeByKey.get(key)
      if (prev === undefined) {
        const anyIdx = out.findIndex((x) => x.type === 'youtube')
        if (anyIdx >= 0) {
          out[anyIdx] = p
          youtubeByKey.set(key, anyIdx)
        } else {
          youtubeByKey.set(key, out.length)
          out.push(p)
        }
      } else {
        out[prev] = p
      }
      continue
    }
    if (p.type === 'video' || p.type === 'audio' || p.type === 'image') {
      const key = `${p.type}:${p.ref}`
      const prev = mediaByRef.get(key)
      if (prev === undefined) {
        mediaByRef.set(key, out.length)
        out.push(p)
      } else {
        out[prev] = p
      }
      continue
    }
    if (p.type === 'choices') {
      const key = choicesPromptKey(p)
      const prev = choicesByPrompt.get(key)
      if (prev === undefined) {
        choicesByPrompt.set(key, out.length)
        out.push(p)
      } else {
        out[prev] = p
      }
      continue
    }
    if (p.type === 'text') {
      const text = (p.text ?? '').trim()
      if (!text) continue
      const prevIdx = out.findIndex((x) => x.type === 'text' && (x.text ?? '').trim() === text)
      if (prevIdx >= 0) {
        out[prevIdx] = p
        continue
      }
    }
    out.push(p)
  }
  return out
}
