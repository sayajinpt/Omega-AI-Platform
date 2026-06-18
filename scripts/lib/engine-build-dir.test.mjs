import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveEngineBuildDir } from './engine-build-dir.mjs'

describe('resolveEngineBuildDir', () => {
  it('uses a short path for Vulkan on long Windows repo roots', () => {
    if (process.platform !== 'win32') return
    const root = 'C:\\Users\\birdy\\Desktop\\project_Omega\\Omega'
    const hit = resolveEngineBuildDir(root, { enableVulkan: true })
    assert.notEqual(hit.dir, join(root, 'apps', 'engine', 'build'))
    assert.match(hit.dir, /AppData\\Local\\O\\eb$/i)
    assert.equal(hit.short, true)
  })

  it('keeps in-tree build dir for short roots without Vulkan', () => {
    const root = 'C:\\dev\\Omega'
    const hit = resolveEngineBuildDir(root, { enableVulkan: false })
    assert.equal(hit.dir, join(root, 'apps', 'engine', 'build'))
    assert.equal(hit.short, false)
  })
})
