import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  resolveEngineBuildDir,
  engineBuildDirRepoId,
  invalidateEngineBuildCacheIfSourceMoved
} from './engine-build-dir.mjs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

describe('resolveEngineBuildDir', () => {
  it('uses a short path for Vulkan on long Windows repo roots', () => {
    if (process.platform !== 'win32') return
    const root = 'C:\\Users\\birdy\\Desktop\\project_Omega\\Omega'
    const hit = resolveEngineBuildDir(root, { enableVulkan: true })
    assert.notEqual(hit.dir, join(root, 'apps', 'engine', 'build'))
    assert.match(hit.dir, /AppData\\Local\\O\\eb-[a-f0-9]{8}$/i)
    assert.equal(hit.short, true)
  })

  it('uses a short path for Downloads clones', () => {
    if (process.platform !== 'win32') return
    const root = 'C:\\Users\\birdy\\Downloads\\Omega-AI-Platform-main\\Omega-AI-Platform-main'
    const hit = resolveEngineBuildDir(root, { enableCuda: true })
    assert.match(hit.dir, /AppData\\Local\\O\\eb-[a-f0-9]{8}$/i)
    assert.equal(hit.short, true)
  })

  it('assigns different short dirs to different clone paths', () => {
    if (process.platform !== 'win32') return
    const a = resolveEngineBuildDir('C:\\dev\\Omega-AI-Platform', { enableVulkan: true })
    const b = resolveEngineBuildDir('C:\\dev\\Omega-AI-Platform-copy', { enableVulkan: true })
    assert.notEqual(a.dir, b.dir)
  })

  it('keeps in-tree build dir for short roots without Vulkan', () => {
    const root = 'C:\\dev\\Omega'
    const hit = resolveEngineBuildDir(root, { enableVulkan: false })
    assert.equal(hit.dir, join(root, 'apps', 'engine', 'build'))
    assert.equal(hit.short, false)
  })

  it('repo id is stable for the same root', () => {
    const root = 'C:\\dev\\Omega'
    assert.equal(engineBuildDirRepoId(root), engineBuildDirRepoId(root))
  })
})

describe('invalidateEngineBuildCacheIfSourceMoved', () => {
  it('clears CMake cache when source path changed', () => {
    const buildDir = join(tmpdir(), `omega-eb-test-${Date.now()}`)
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(
      join(buildDir, 'CMakeCache.txt'),
      'CMAKE_HOME_DIRECTORY:INTERNAL=C:/old/path/Omega/apps/engine\n',
      'utf8'
    )
    const root = join(tmpdir(), 'omega-root-test')
    const cleared = invalidateEngineBuildCacheIfSourceMoved(root, buildDir)
    assert.equal(cleared, true)
    rmSync(buildDir, { recursive: true, force: true })
  })
})
