param(
  [Parameter(Mandatory = $true)]
  [string]$Variant,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib-vs-tools.ps1")

$Root = Split-Path -Parent $PSScriptRoot
$LlamaRoot = Join-Path $Root "apps\engine\native\third_party\llama.cpp"
$BuildDir = Join-Path $Root ".omega\build\llama-infer\$Variant"

if (-not (Test-Path (Join-Path $LlamaRoot "CMakeLists.txt"))) {
  Write-Error '[build-infer-source] llama.cpp not synced — run node scripts/sync-llama-cpp.mjs'
}

$cmake = Get-VsCMake
if (-not $cmake) {
  Write-Error '[build-infer-source] CMake not found (Visual Studio or OMEGA_CMAKE)'
}

Initialize-VsDevEnvironment -Arch amd64 | Out-Null
Write-Host ('[build-infer-source] CMake: ' + $cmake)

$env:OMEGA_LLAMA_VARIANT = $Variant
$cmakeArgsJson = node (Join-Path $PSScriptRoot "lib\infer-source-cmake-args.mjs") --cmake-args --variant=$Variant
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$extra = $cmakeArgsJson | ConvertFrom-Json

if ($Force -and (Test-Path $BuildDir)) {
  Remove-Item -Recurse -Force $BuildDir
}
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

$configure = @(
  "-S", $LlamaRoot,
  "-B", $BuildDir,
  "-DCMAKE_BUILD_TYPE=Release"
) + $extra

Write-Host ('[build-infer-source] configure ' + ($configure -join ' '))
& $cmake @configure
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $cmake --build $BuildDir --config Release --target llama-server llama-quantize
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ('[build-infer-source] OK under ' + $BuildDir)
