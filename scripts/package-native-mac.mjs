#!/usr/bin/env node
/**
 * Stage macOS Omega.app bundle under dist/native/Omega.app
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageClaw3dOffice } from './lib/stage-claw3d-resources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellSrc = join(root, 'dist', 'shell')
const appSrc = join(shellSrc, 'omega-desktop.app')
const outApp = join(root, 'dist', 'native', 'Omega.app')

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false
  cpSync(src, dest, { recursive: true })
  return true
}

if (!existsSync(appSrc)) {
  console.error('[package-native-mac] missing dist/shell/omega-desktop.app — run: npm run build:shell')
  process.exit(1)
}

if (existsSync(outApp)) rmSync(outApp, { recursive: true, force: true })
mkdirSync(join(root, 'dist', 'native'), { recursive: true })
cpSync(appSrc, outApp, { recursive: true })

const resources = join(outApp, 'Contents', 'Resources')
mkdirSync(resources, { recursive: true })

for (const [srcRel, destRel] of [
  ['ui', 'ui'],
  ['runtime', 'runtime'],
  ['engine', 'engine'],
  ['bin', 'bin']
]) {
  copyIfExists(join(shellSrc, srcRel), join(resources, destRel))
}

copyIfExists(join(root, 'dist', 'content-studio'), join(resources, 'content-studio'))
copyIfExists(join(root, 'apps', 'desktop', 'content-studio'), join(resources, 'content-studio'))
stageClaw3dOffice(root, resources)
copyIfExists(join(root, 'engines'), join(resources, 'engines'))

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.1.0'
writeFileSync(join(resources, 'VERSION'), version + '\n', 'utf8')
writeFileSync(join(resources, 'runtime', 'VERSION'), version + '\n', 'utf8')

console.log('[package-native-mac] OK:', outApp)
