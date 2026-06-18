/**
 * Ensure apps/desktop/resources/icon.png exists (round Ω icon).
 * Windows: uses ensure-app-icon.ps1 (System.Drawing).
 * Other OS: skip if icon already present (commit icon.png for CI/mac/linux).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconPath = join(root, 'apps', 'desktop', 'resources', 'icon.png')

if (existsSync(iconPath)) {
  console.log(`app icon: ${iconPath}`)
  process.exit(0)
}

if (process.platform === 'win32') {
  const ps1 = join(root, 'scripts', 'ensure-app-icon.ps1')
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { stdio: 'inherit' }
  )
  if (!existsSync(iconPath)) {
    console.error('ensure-app-icon.ps1 did not create icon.png')
    process.exit(1)
  }
  process.exit(0)
}

console.error(
  `Missing ${iconPath}. On Windows run: node scripts/ensure-app-icon.mjs\n` +
    'Or commit icon.png after generating once on Windows.'
)
process.exit(1)
