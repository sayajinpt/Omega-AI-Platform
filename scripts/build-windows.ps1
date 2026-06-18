# Omega - one-click Windows installer build (terminal UI + full pipeline).
# ASCII-only source for Windows PowerShell 5.1 compatibility.
# Use Continue: npm/vite write warnings to stderr; Stop would abort the build on those.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $root "build-log.txt"
$lockFile = Join-Path $root ".omega\llama-setup.json"
. (Join-Path $PSScriptRoot "omega-ui.ps1")
Push-Location $root

$brand = [char]937 + 'mega'

function Require-Command($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-OmegaFail
    Write-OmegaLog -Level err -Message "$name not found. $hint"
    Read-Host "Press Enter to close"
    Pop-Location
    exit 1
  }
}

function Test-OmegaWorkspaceLayout {
  $missing = @()
  foreach ($rel in @('apps\desktop\package.json', 'packages\sdk\package.json')) {
    if (-not (Test-Path (Join-Path $root $rel))) { $missing += $rel }
  }
  if ($missing.Count -eq 0) { return $true }
  Write-OmegaFail
  Write-OmegaLog -Level err -Message "Omega source tree is incomplete (missing: $($missing -join ', '))"
  Write-OmegaLog -Level err -Message "Restore apps/desktop from your Omega repo or backup, then run build.bat again."
  return $false
}

# npm install / node-gyp must use system Node.js, not IDE-embedded Node (Cursor, VS Code).
# Mixed PATH causes corrupted node_modules (missing deep-extend/retry) or exit -1073740791.
function Set-OmegaBuildNodeEnvironment {
  $node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
  if (-not $node) { return }
  $nodeDir = Split-Path -Parent $node
  $pathParts = @($nodeDir)
  foreach ($part in ($env:Path -split ';')) {
    if (-not $part) { continue }
    if ($part -ieq $nodeDir) { continue }
    if ($part -match 'cursor|Code\\resources\\app\\resources\\helpers') { continue }
    $pathParts += $part
  }
  $env:Path = ($pathParts -join ';')
  $gyp = Join-Path $nodeDir "node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"
  if (Test-Path $gyp) { $env:npm_config_node_gyp = $gyp }
}

function Get-PrimaryVariantFromLock {
  if (-not (Test-Path $lockFile)) { return $null }
  try {
    $lock = Get-Content $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($lock.primaryVariant) { return $lock.primaryVariant.Trim() }
    if ($lock.variants) {
      $keys = @($lock.variants.PSObject.Properties.Name)
      if ($keys.Count -eq 1) { return $keys[0] }
      foreach ($k in @('win-cuda', 'win-vulkan', 'nvidia-vulkan-windows')) {
        if ($keys -contains $k) {
          if ($k -eq 'nvidia-vulkan-windows') { return 'win-vulkan' }
          return $k
        }
      }
      if ($keys.Count -gt 0) { return $keys[-1] }
    }
  } catch {
    Write-OmegaLog -Level warn -Message "Could not read llama lock: $($_.Exception.Message)"
  }
  return $null
}

Write-OmegaBanner -Title "$brand - Windows installer build"
Write-Host "  Log: $logFile" -ForegroundColor DarkGray
Write-Host "  You will choose llama.cpp version, prebuilt vs source, and NVIDIA or Vulkan." -ForegroundColor DarkGray
Write-Host ""

Start-OmegaBootSequence -Mode "win"

Require-Command "node" "Install Node.js 20+ from https://nodejs.org"
Write-OmegaLog -Level ok -Message "node $(node -v)"
Require-Command "npm" "npm ships with Node.js"
Write-OmegaLog -Level ok -Message "npm ready"
Require-Command "git" "Install Git - used to fetch Claw3D during build"
Write-OmegaLog -Level ok -Message "git ready"
Require-Command "python" "Install Python 3.10+ - Content Studio venv"
Write-OmegaLog -Level ok -Message "python ready"

"==== Omega build $(Get-Date -Format o) ====" | Out-File -FilePath $logFile -Encoding utf8

if (-not (Test-OmegaWorkspaceLayout)) {
  Read-Host "Press Enter to close"
  Pop-Location
  exit 1
}

$totalSteps = 4

Write-OmegaStep -Current 1 -Total $totalSteps -Label "Clean npm trees (fresh workspace install)"
Write-OmegaProgressBar -Percent 2
$cleanOut = @(node scripts/clean-install.mjs 2>&1)
$cleanCode = $LASTEXITCODE
$cleanOut | ForEach-Object { Write-Host $_; Add-Content -Path $logFile -Value $_ -Encoding utf8 }
if ($cleanCode -ne 0) {
  Write-OmegaFail
  Write-OmegaLog -Level err -Message "clean-install failed (exit $cleanCode)"
  Read-Host "Press Enter to close"
  Pop-Location
  exit $cleanCode
}
Write-OmegaLog -Level ok -Message "npm trees cleared"
Write-OmegaProgressBar -Percent 8

Write-OmegaStep -Current 2 -Total $totalSteps -Label "npm install"
Write-OmegaProgressBar -Percent 10
Set-OmegaBuildNodeEnvironment
Write-OmegaLog -Level info -Message "Using Node from PATH: $(node -v) ($(Get-Command node | Select-Object -ExpandProperty Source))"
$installOut = @(npm install 2>&1)
$installCode = $LASTEXITCODE
$installOut | ForEach-Object { Write-Host $_; Add-Content -Path $logFile -Value $_ -Encoding utf8 }
if ($installCode -ne 0) {
  Write-OmegaFail
  Write-OmegaLog -Level err -Message "npm install failed (exit $installCode)"
  if ($installCode -eq (-1073740791)) {
    Write-OmegaLog -Level err -Message "Native crash during install - close Omega/Cursor, run build.bat from Explorer (not IDE terminal), then retry."
  }
  Write-OmegaLog -Level err -Message "If npm install failed: close apps using node_modules, delete Omega\\node_modules, run build.bat again."
  Write-OmegaLog -Level err -Message "Full log: $env:LOCALAPPDATA\npm-cache\_logs (latest debug log)"
  Read-Host "Press Enter to close"
  Pop-Location
  exit $installCode
}
Write-OmegaLog -Level ok -Message "dependencies installed"
Write-OmegaProgressBar -Percent 20

Write-OmegaStep -Current 3 -Total $totalSteps -Label 'llama.cpp (version, prebuilt/source, GPU)'
Write-OmegaLog -Level info -Message "Answer the prompts below (release tag, prebuilt/source, NVIDIA or Vulkan)"
Write-OmegaProgressBar -Percent 25
Write-Host ""
Write-OmegaLog -Level info -Message "Latest llama.cpp prebuilt matrix (GitHub releases)"
& node scripts/fetch-infer-binaries.mjs --catalog-only --installer 2>&1 | ForEach-Object {
  Write-Host $_
  Add-Content -Path $logFile -Value $_ -Encoding utf8
}
Write-Host ""
# Do NOT capture output here — @(node ... 2>&1) buffers stdin/stdout and hides readline prompts.
Add-Content -Path $logFile -Value "---- llama-setup (interactive) ----" -Encoding utf8
& node scripts/llama-setup.mjs --installer
$llamaCode = $LASTEXITCODE
Add-Content -Path $logFile -Value "---- llama-setup exit $llamaCode ----" -Encoding utf8
Write-Host ""
if ($llamaCode -ne 0) {
  Write-OmegaFail
  Write-OmegaLog -Level err -Message "llama setup failed (exit $llamaCode)"
  Read-Host "Press Enter to close"
  Pop-Location
  exit $llamaCode
}

$variant = Get-PrimaryVariantFromLock
if ($variant) {
  $env:OMEGA_LLAMA_VARIANT = $variant
  Write-OmegaLog -Level ok -Message "GPU variant: $variant"
} else {
  Write-OmegaLog -Level warn -Message "No primary variant in lock - defaulting to win-cuda"
  $env:OMEGA_LLAMA_VARIANT = "win-cuda"
}
Write-OmegaProgressBar -Percent 45

Write-OmegaStep -Current 4 -Total $totalSteps -Label "Full production build (Content Studio, Office, engines, installer)"
Write-OmegaLog -Level info -Message "first run can take a long time (Claw3D clone + npm build)"
Write-OmegaProgressBar -Percent 50
Set-OmegaBuildNodeEnvironment
# Run directly so $LASTEXITCODE is reliable (pipelines break exit codes on PS 5.1).
& npm run build:win *>&1 | ForEach-Object {
  Write-Host $_
  Add-Content -Path $logFile -Value $_ -Encoding utf8
}
if (-not $?) { $code = 1 } else { $code = $LASTEXITCODE }
if ($code -eq 0 -and $LASTEXITCODE -ne 0) { $code = $LASTEXITCODE }

if ($code -ne 0) {
  Write-OmegaFail
  Write-OmegaLog -Level err -Message "build failed (exit $code) - see $logFile"
  Read-Host "Press Enter to close"
  Pop-Location
  exit $code
}

Write-OmegaProgressBar -Percent 100
Write-OmegaSuccess
$outDir = Join-Path $root "dist\native\Omega"
Write-OmegaLog -Level ok -Message "native app folder: $outDir"
if (Test-Path (Join-Path $outDir "omega-desktop.exe")) {
  Write-OmegaLog -Level ok -Message (Join-Path $outDir "omega-desktop.exe")
}
Write-Host ""
Pop-Location
exit 0
