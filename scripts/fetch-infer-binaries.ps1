# Downloads llama.cpp release binaries into dist/bin/<variant>/.
# CUDA zip matches installed toolkit major (12.x / 13.x).
# Usage:
#   .\scripts\fetch-infer-binaries.ps1 [-Force] [-Variant win-cuda]
#   .\scripts\fetch-infer-binaries.ps1 -AllHostVariants [-Force]
#   .\scripts\fetch-infer-binaries.ps1 -CatalogOnly [-Tag b9272]

param(
    [switch]$CpuOnly,
    [switch]$Force,
    [switch]$AllHostVariants,
    [switch]$CatalogOnly,
    [string]$Variant = "",
    [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$nodeArgs = @("node", (Join-Path $scriptDir "fetch-infer-binaries.mjs"))
if ($Variant) { $nodeArgs += "--variant=$Variant" }
if ($Tag) { $nodeArgs += "--tag=$Tag" }
if ($CpuOnly) { $nodeArgs += "--cpu-only" }
if ($Force) { $nodeArgs += "--force" }
if ($AllHostVariants) { $nodeArgs += "--all-host-variants" }
if ($CatalogOnly) { $nodeArgs += "--catalog-only" }
& @nodeArgs
exit $LASTEXITCODE
