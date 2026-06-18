# Omega native desktop build (WebView2 shell — no Electron).
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "omega-ui.ps1")
Push-Location $root

$brand = [char]937 + 'mega'
Write-OmegaBanner -Title "$brand - Native desktop build (WebView2)"
Write-OmegaLog -Level info -Message "Building omega-desktop + omega-runtime (no Electron)"

Write-OmegaLog -Level info -Message "Ensuring Content Studio, Claw3D, engines…"
node scripts/ensure-content-studio.mjs 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-OmegaFail
  Pop-Location
  exit $LASTEXITCODE
}
node scripts/ensure-claw3d-office.mjs 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-OmegaFail
  Pop-Location
  exit $LASTEXITCODE
}
npm run -w @omega/desktop ensure-engines 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-OmegaFail
  Pop-Location
  exit $LASTEXITCODE
}

node scripts/generate-route-catalog.mjs 2>&1 | ForEach-Object { Write-Host $_ }
npm run build:shell 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-OmegaFail
  Pop-Location
  exit $LASTEXITCODE
}

node scripts/package-native-installer.mjs 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-OmegaFail
  Pop-Location
  exit $LASTEXITCODE
}

Write-OmegaLog -Level info -Message "Syncing runtime into existing install (if any)…"
node scripts/sync-installed-omega.mjs 2>&1 | ForEach-Object { Write-Host $_ }

Write-OmegaSuccess
Write-OmegaLog -Level ok -Message "Native app: dist\native\Omega\omega-desktop.exe"
Write-OmegaLog -Level ok -Message "Installer (if NSIS installed): dist\native\Omega-*-Setup.exe"
Pop-Location
exit 0
