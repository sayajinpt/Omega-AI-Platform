# Rewrite HEAD commit message without Co-authored-by trailer.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$tree = (git rev-parse "HEAD^{tree}").Trim()
$parent = (git rev-parse "HEAD^").Trim()
$msgFile = Join-Path $env:TEMP "omega-commit-msg.txt"
Set-Content -Path $msgFile -Value "Omega v2 native desktop stack - full source upload (build artifacts excluded)." -Encoding ASCII

$new = (git commit-tree $tree -p $parent -F $msgFile).Trim()
if (-not $new) { throw "commit-tree failed" }

git reset --hard $new
Write-Host "New commit: $new"
git log -1 --pretty=format:%B
