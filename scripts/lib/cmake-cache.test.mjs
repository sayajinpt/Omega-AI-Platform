import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { invalidateCmakeCacheIfSourceMoved, normalizePath } from './cmake-cache.mjs'

describe('cmake-cache', () => {
  it('normalizePath is case-insensitive on Windows-style paths', () => {
    assert.equal(
      normalizePath('C:/Foo/Bar'),
      normalizePath('c:\\foo\\bar')
    )
  })

  it('clears cache when CMAKE_HOME_DIRECTORY differs', () => {
    const buildDir = join(tmpdir(), `omega-cmake-${Date.now()}`)
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(
      join(buildDir, 'CMakeCache.txt'),
      'CMAKE_HOME_DIRECTORY:INTERNAL=C:/other/apps/runtime\n',
      'utf8'
    )
    const ok = invalidateCmakeCacheIfSourceMoved(
      join(tmpdir(), 'omega-runtime-src'),
      buildDir,
      'test'
    )
    assert.equal(ok, true)
    assert.equal(existsSync(join(buildDir, 'CMakeCache.txt')), false)
    rmSync(buildDir, { recursive: true, force: true })
  })
})
