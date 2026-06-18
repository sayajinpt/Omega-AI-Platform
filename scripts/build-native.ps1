# Build libomega_infer (llama.cpp) into apps/engine/native/lib
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib-vs-tools.ps1")

$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root "apps\engine\native"
$llamaDir = Join-Path $native "third_party\llama.cpp"
$libDir = Join-Path $native "lib"
$buildDir = Join-Path $native "build"

$cmake = Resolve-OmegaToolchain

New-Item -ItemType Directory -Force -Path $libDir | Out-Null

$syncScript = Join-Path $root "scripts\sync-llama-cpp.mjs"
if (Test-Path $syncScript) {
  Write-Host "Syncing local llama.cpp into third_party (if present)..."
  $env:OMEGA_SYNC_RUNTIME_ONLY = "1"
  & node $syncScript
  Remove-Item Env:\OMEGA_SYNC_RUNTIME_ONLY -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $llamaDir "CMakeLists.txt"))) {
  Write-Host "Cloning llama.cpp into $llamaDir ..."
  New-Item -ItemType Directory -Force -Path (Split-Path $llamaDir) | Out-Null
  git clone --depth 1 https://github.com/ggml-org/llama.cpp $llamaDir
  if ($LASTEXITCODE -ne 0) { throw "git clone llama.cpp failed" }
}

Write-Host "Configuring libomega_infer..."
& $cmake -S $native -B $buildDir -DOMEGA_HAVE_LLAMA_CPP=ON "-DLLAMA_CPP_DIR=$llamaDir" -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }

Write-Host "Building libomega_infer (Release)..."
& $cmake --build $buildDir --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

foreach ($pattern in @("omega_infer*", "libomega_infer*")) {
  Get-ChildItem -Path $buildDir -Recurse -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName -Destination $libDir -Force
    if ($_.Extension -eq ".lib") {
      Copy-Item $_.FullName -Destination (Join-Path $libDir "Release") -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  -> $($_.Name)"
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $libDir "Release") | Out-Null
Get-ChildItem -Path $libDir -Filter "omega_infer.lib" -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName -Destination (Join-Path $libDir "Release") -Force
}

if (-not (Test-Path (Join-Path $libDir "omega_infer.lib")) -and -not (Test-Path (Join-Path $libDir "libomega_infer.lib"))) {
  Write-Warning "omega_infer.lib not found in $libDir - Go cgo link may fail until the library is built."
} else {
  Write-Host "libomega_infer ready in $libDir"
}
