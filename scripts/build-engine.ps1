param(
  [switch]$LinkInfer,
  [switch]$CpuOnly,
  [string]$Config = "Release"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib-vs-tools.ps1")

$Root = Split-Path -Parent $PSScriptRoot
$EngineDir = Join-Path $Root "apps\engine"
$BuildDir = if ($env:OMEGA_ENGINE_BUILD_DIR) { $env:OMEGA_ENGINE_BUILD_DIR } else { Join-Path $EngineDir "build" }
$OutDir = Join-Path $Root "dist\engine"
$NativeDir = Join-Path $Root "apps\engine\native"

function Get-EngineGpuBuildOptions {
  $script = Join-Path $PSScriptRoot "lib\engine-gpu-backend.mjs"
  $node = if ($env:OMEGA_NODE -and (Test-Path $env:OMEGA_NODE)) { $env:OMEGA_NODE } else { "node" }
  $json = & $node $script
  if ($LASTEXITCODE -ne 0) {
    throw "engine-gpu-backend.mjs failed"
  }
  return $json | ConvertFrom-Json
}

function Get-EngineGpuCmakeArgs {
  $script = Join-Path $PSScriptRoot "lib\engine-gpu-backend.mjs"
  $node = if ($env:OMEGA_NODE -and (Test-Path $env:OMEGA_NODE)) { $env:OMEGA_NODE } else { "node" }
  $json = & $node $script --cmake-args
  if ($LASTEXITCODE -ne 0) {
    throw "engine-gpu-backend.mjs --cmake-args failed"
  }
  return $json | ConvertFrom-Json
}

$cmake = Get-VsCMake
if (-not $cmake) {
  Write-Error @"
[build-engine] CMake not found. Install Visual Studio with 'Desktop development with C++' (includes CMake),
standalone CMake from https://cmake.org/download/, or set OMEGA_CMAKE to cmake.exe
"@
}

$gpuOpts = Get-EngineGpuBuildOptions
$gpuCmakeArgs = Get-EngineGpuCmakeArgs
Write-Host ('[build-engine] GPU backend: ' + $gpuOpts.reason)
if ($gpuOpts.enableVulkan -and $gpuOpts.vulkanSdk.root) {
  $env:VULKAN_SDK = $gpuOpts.vulkanSdk.root
  $vulkanBin = Join-Path $gpuOpts.vulkanSdk.root 'Bin'
  if (Test-Path $vulkanBin) {
    $env:Path = "$vulkanBin;$env:Path"
  }
  Write-Host ('[build-engine] VULKAN_SDK=' + $env:VULKAN_SDK)
} elseif ($gpuOpts.variantId -match 'vulkan' -and -not $gpuOpts.enableVulkan) {
  Write-Warning '[build-engine] Vulkan variant without SDK — omega-engine will be CPU-only for GGUF inference. Install LunarG Vulkan SDK (https://vulkan.lunarg.com/) and rebuild.'
}

Initialize-VsDevEnvironment -Arch amd64 | Out-Null
Write-Host ('[build-engine] Using CMake: ' + $cmake)
Write-Host ('[build-engine] build dir: ' + $BuildDir)

if (-not (Test-Path $BuildDir)) { New-Item -ItemType Directory -Path $BuildDir | Out-Null }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$doLink = $LinkInfer -or (Test-Path (Join-Path $NativeDir "CMakeLists.txt"))
$cmakeArgs = @("-S", $EngineDir, "-B", $BuildDir, "-DCMAKE_BUILD_TYPE=$Config")
if ($doLink) {
  $cmakeArgs += "-DOMEGA_ENGINE_LINK_INFER=ON"
  Write-Host '[build-engine] linking libomega_infer'
  if ($CpuOnly) {
    Write-Host '[build-engine] -CpuOnly: forcing CPU-only libomega_infer'
    $cmakeArgs += @("-DOMEGA_GGML_CUDA=OFF", "-DOMEGA_GGML_VULKAN=OFF")
  } else {
    $cmakeArgs += $gpuCmakeArgs
    if (-not $gpuOpts.enableCuda -and -not $gpuOpts.enableVulkan) {
      Write-Host '[build-engine] CPU-only libomega_infer'
    }
  }
}

Write-Host ('[build-engine] configuring ' + $BuildDir)

$cacheFile = Join-Path $BuildDir "CMakeCache.txt"
if (Test-Path $cacheFile) {
  $engineDirNorm = (Resolve-Path $EngineDir).Path.ToLower().Replace('/', '\')
  $cacheText = Get-Content $cacheFile -Raw
  if ($cacheText -match 'CMAKE_HOME_DIRECTORY:INTERNAL=([^\r\n]+)') {
    $cached = $Matches[1].Trim().ToLower().Replace('/', '\')
    if ($cached -ne $engineDirNorm) {
      Write-Host "[build-engine] CMake cache is from a different folder — clearing"
      Remove-Item $cacheFile -Force
      Remove-Item (Join-Path $BuildDir ".omega-gpu-backend") -Force -ErrorAction SilentlyContinue
    }
  }
}

& $cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Root -match '\\Desktop\\' -or $Root -match '\\OneDrive\\') {
  Write-Warning '[build-engine] Project is under Desktop or OneDrive — cloud sync can lock CUDA object files and cause "Permission denied". Exclude apps\engine\build from sync or move the repo off Desktop.'
}

function Get-MsBuildParallel {
  if ($env:OMEGA_MSBUILD_PARALLEL) {
    return [int]$env:OMEGA_MSBUILD_PARALLEL
  }
  if ($gpuOpts.enableCuda) {
    return 1
  }
  return 0
}

$parallel = Get-MsBuildParallel
$buildArgs = @('--build', $BuildDir, '--config', $Config)
if ($parallel -gt 0) {
  $buildArgs += @('--parallel', "$parallel")
  Write-Host ("[build-engine] MSBuild parallel jobs: $parallel (set OMEGA_MSBUILD_PARALLEL to override)")
}

$maxAttempts = if ($gpuOpts.enableCuda) { 3 } else { 1 }
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  & $cmake @buildArgs
  if ($LASTEXITCODE -eq 0) { break }
  if ($attempt -lt $maxAttempts) {
    Write-Host ('[build-engine] build failed (attempt ' + $attempt + '/' + $maxAttempts + '), retrying in 5s...')
    Write-Host '[build-engine] tip: close other MSBuild/nvcc processes; pause antivirus on apps\engine\build'
    Start-Sleep -Seconds 5
  }
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $BuildDir "$Config\omega-engine.exe"
if (-not (Test-Path $exe)) {
  $exe = Join-Path $BuildDir "Release\omega-engine.exe"
}
if (-not (Test-Path $exe)) {
  $exe = Join-Path $BuildDir "omega-engine.exe"
}
if (-not (Test-Path $exe)) {
  Write-Error ('[build-engine] build finished but omega-engine.exe not found under ' + $BuildDir)
}

$dest = Join-Path $OutDir "omega-engine.exe"
Copy-Item -Force $exe $dest
$srcDir = Split-Path -Parent $exe
Get-ChildItem $srcDir -Filter "*.dll" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^(cudart64_\d+\.dll|cublas64_\d+\.dll|cublasLt64_\d+\.dll)$') { return }
  Copy-Item -Force $_.FullName (Join-Path $OutDir $_.Name)
}
$inferLib = Join-Path $NativeDir "lib"
if (Test-Path $inferLib) {
  Get-ChildItem $inferLib -Filter "*.dll" -ErrorAction SilentlyContinue | ForEach-Object {
    $d = Join-Path $OutDir $_.Name
    if (-not (Test-Path $d)) { Copy-Item -Force $_.FullName $d }
  }
}

Write-Host ('[build-engine] OK: ' + $dest)
Write-Host '[build-engine] CUDA runtime DLLs live in dist/bin only (shared via PATH at runtime)'
