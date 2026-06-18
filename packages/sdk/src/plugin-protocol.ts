/**
 * Plugin architecture contract (Phase 13).
 * Node plugins today; native `PluginInterface` in apps/engine later.
 */
import type { PluginCatalogEntry, PluginInfo, PluginManifest } from './index.js'

/** Permission tokens declared in omega-plugin.json. */
export type PluginPermission = 'fetch' | 'fs-read' | 'fs-write' | 'network' | 'subprocess'

export interface PluginToolDefinition {
  name: string
  description: string
  handler: string
  permissions?: PluginPermission[]
}

/** Normalized on-disk manifest after validation. */
export interface PluginManifestNormalized {
  id: string
  name: string
  version: string
  description: string
  author?: string
  entry: string
  permissions: PluginPermission[]
  tools: PluginToolDefinition[]
}

/** Runtime mount record exposed to UI / engine commands. */
export interface PluginMountInfo extends PluginInfo {
  loadErrors?: string[]
}

export interface PluginToolMount {
  namespacedName: string
  description: string
  pluginId: string
  toolName: string
}

/** Snapshot from the engine plugin loader. */
export interface PluginLoaderStatus {
  plugins: PluginInfo[]
  tools: PluginToolMount[]
  errors: Record<string, string[]>
}

/** Agent-authored plugin write request (write_plugin tool). */
export interface WritePluginRequest {
  pluginId: string
  name: string
  description: string
  version?: string
  permissions?: string[]
  tools: Array<{ name: string; description?: string; permissions?: string[] }>
  source: string
}

export interface WritePluginResult {
  ok: boolean
  output: string
  pluginId?: string
}

/**
 * Plugin host surface — implemented by engine-bridge loader today,
 * eventually by native engine for WASM/.so plugins.
 */
export interface PluginInterface {
  list(): PluginInfo[]
  status(): PluginLoaderStatus
  toggle(id: string, enabled: boolean): PluginInfo[]
  reload(): PluginInfo[]
  catalog(): PluginCatalogEntry[]
  installBuiltin(id: string): Promise<PluginManifest>
  installUrl(url: string): Promise<PluginManifest>
  uninstall(id: string): void
  write(input: WritePluginRequest): WritePluginResult
  runTool(name: string, args: Record<string, string>): Promise<{ ok: boolean; output: string }>
}

/** Namespaced tool id: `pluginId:toolName` */
export function namespacedPluginToolName(pluginId: string, toolName: string): string {
  return `${pluginId}:${toolName}`
}

export function parseNamespacedPluginTool(name: string): { pluginId: string; toolName: string } | null {
  const i = name.indexOf(':')
  if (i <= 0 || name.startsWith('mcp:')) return null
  return { pluginId: name.slice(0, i), toolName: name.slice(i + 1) }
}

export function isPluginToolName(name: string): boolean {
  return parseNamespacedPluginTool(name) !== null
}
