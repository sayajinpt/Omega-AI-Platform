import type { HFFile } from './index.js'

/** Format byte count as GiB (binary GB). */
export function formatFileGiB(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  return `${(bytes / 1024 ** 3).toFixed(digits)} GB`
}

const SHARD_NAME_RE = /^(.+)-(\d+)-of-(\d+)(\.\w+)$/i

/** Group key for split GGUF/safetensors shards (e.g. model-00001-of-00003.gguf). */
export function shardGroupKey(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? path
  const m = name.match(SHARD_NAME_RE)
  if (!m) return null
  return `${m[1]}${m[4]}`.toLowerCase()
}

/** Total on-disk bytes for this file, summing all shards in the same split group. */
export function effectiveFileSizeBytes(file: HFFile, files: HFFile[]): number {
  const key = shardGroupKey(file.path)
  if (!key) return file.size
  return files
    .filter((f) => shardGroupKey(f.path) === key)
    .reduce((sum, f) => sum + f.size, 0)
}

/** All paths required when `path` is one part of a multi-file shard set. */
export function expandShardPaths(files: HFFile[], path: string): string[] {
  const key = shardGroupKey(path)
  if (!key) return [path]
  const shards = files.filter((f) => shardGroupKey(f.path) === key)
  if (shards.length <= 1) return [path]
  return shards.sort((a, b) => a.path.localeCompare(b.path)).map((f) => f.path)
}
