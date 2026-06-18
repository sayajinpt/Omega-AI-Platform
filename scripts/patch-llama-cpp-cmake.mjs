#!/usr/bin/env node
/** Patch synced llama.cpp so MSBuild does not re-run CMake mid-compile. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targets = [
  join(root, 'apps', 'engine', 'native', 'third_party', 'llama.cpp'),
  join(root, 'apps', 'runtime', 'native', 'third_party', 'llama.cpp')
]

const marker = 'Omega: skip git index CMAKE_CONFIGURE_DEPENDS'
const re =
  /(\s*)set_property\(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "\$\{GIT_DIR\}\/index"\)/

let ok = 0
for (const llamaRoot of targets) {
  const file = join(llamaRoot, 'common', 'CMakeLists.txt')
  if (!existsSync(file)) continue
  let txt = readFileSync(file, 'utf8')
  if (txt.includes(marker)) {
    console.log('[patch-llama-cpp-cmake] already patched:', file)
    ok++
    continue
  }
  if (!re.test(txt)) {
    console.warn('[patch-llama-cpp-cmake] pattern not found:', file)
    continue
  }
  txt = txt.replace(
    re,
    `$1# ${marker}\n$1# set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "\${GIT_DIR}/index")`
  )
  writeFileSync(file, txt)
  ok++
  console.log('[patch-llama-cpp-cmake] patched:', file)
}

if (!ok) {
  console.warn('[patch-llama-cpp-cmake] no llama.cpp tree synced yet — run setup first')
}
