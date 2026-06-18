# Shared Visual Studio / CMake discovery for Omega native builds.
# Dot-source from build-native.ps1 and build-runtime-native.ps1:
#   . (Join-Path $PSScriptRoot "lib-vs-tools.ps1")

function Find-VsWhere {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Get-VsInstallPath {
  $vw = Find-VsWhere
  if (-not $vw) { return $null }
  $path = & $vw -latest -property installationPath 2>$null
  if ($path -and (Test-Path $path)) { return $path.Trim() }
  return $null
}

function Get-VsCMake {
  if ($env:OMEGA_CMAKE -and (Test-Path $env:OMEGA_CMAKE)) {
    return $env:OMEGA_CMAKE
  }
  $cmd = Get-Command cmake -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $vw = Find-VsWhere
  if ($vw) {
    $found = & $vw -latest -find "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" 2>$null
    if ($found) {
      $p = if ($found -is [array]) { $found[0] } else { $found }
      if ($p -and (Test-Path $p)) { return $p }
    }
  }

  $install = Get-VsInstallPath
  if ($install) {
    $bundled = Join-Path $install "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
    if (Test-Path $bundled) { return $bundled }
  }

  $fallbacks = @(
    "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
    "C:\Program Files\CMake\bin\cmake.exe"
  )
  foreach ($p in $fallbacks) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Initialize-VsDevEnvironment {
  param(
    [ValidateSet("x86", "amd64", "arm64")]
    [string] $Arch = "amd64"
  )

  $install = Get-VsInstallPath
  if (-not $install) {
    Write-Warning "Visual Studio installation not found via vswhere."
    return $false
  }

  $devShell = Join-Path $install "Common7\Tools\Launch-VsDevShell.ps1"
  if (Test-Path $devShell) {
    Write-Host "Loading VS dev environment: $install ($Arch)"
    & $devShell -Arch $Arch -SkipAutomaticLocation
    return $true
  }

  $vcvars = Join-Path $install "VC\Auxiliary\Build\vcvarsall.bat"
  if (-not (Test-Path $vcvars)) {
    Write-Warning "vcvarsall.bat not found under $install"
    return $false
  }

  Write-Host "Loading VS dev environment via vcvarsall ($Arch)..."
  $archArg = switch ($Arch) {
    "x86" { "x86" }
    "arm64" { "arm64" }
    default { "amd64" }
  }
  cmd /c "`"$vcvars`" $archArg >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") {
      Set-Item -Path "env:$($matches[1])" -Value $matches[2]
    }
  }
  return $true
}

function Resolve-OmegaToolchain {
  $cmake = Get-VsCMake
  if (-not $cmake) {
    throw @"
CMake not found. Install one of:
  - Visual Studio with 'Desktop development with C++' and CMake component
  - Standalone CMake (https://cmake.org/download/)
Or set: `$env:OMEGA_CMAKE = 'C:\path\to\cmake.exe'
"@
  }
  Initialize-VsDevEnvironment -Arch amd64 | Out-Null
  Write-Host "Using CMake: $cmake"
  return $cmake
}
