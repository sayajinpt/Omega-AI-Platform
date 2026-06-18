# Upload Omega source to GitHub (run from repo root).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\push-to-github.ps1
#
# Requires: Git for Windows, GitHub login (browser or personal access token).

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$Remote = "https://github.com/sayajinpt/Omega-AI-Platform.git"

Write-Host "Omega repo root: $Root" -ForegroundColor Cyan

if (-not (Test-Path ".git")) {
  Write-Host "Initializing git in Omega folder..." -ForegroundColor Yellow
  git init
  git branch -M main
}

if (-not (git remote get-url origin 2>$null)) {
  git remote add origin $Remote
  Write-Host "Added remote: $Remote"
} else {
  $current = git remote get-url origin
  if ($current -ne $Remote) {
    Write-Host "Updating origin: $current -> $Remote"
    git remote set-url origin $Remote
  }
}

Write-Host "Staging files (respecting .gitignore)..." -ForegroundColor Cyan
git add -A
$status = git status --short
if (-not $status) {
  Write-Host "Nothing to commit." -ForegroundColor Green
} else {
  git commit -m @"
Omega v2 native desktop stack.

WebView shell + C++ runtime, React UI, Content Studio, docs.
"@
}

Write-Host "Fetching remote main (may contain README only)..." -ForegroundColor Cyan
git fetch origin main 2>$null
$hasRemote = git rev-parse --verify origin/main 2>$null
if ($LASTEXITCODE -eq 0) {
  git pull origin main --allow-unrelated-histories --no-edit
}

Write-Host "Pushing to GitHub..." -ForegroundColor Cyan
Write-Host "If prompted, sign in with your GitHub account or paste a Personal Access Token." -ForegroundColor Yellow
git push -u origin main

Write-Host "Done. See: https://github.com/sayajinpt/Omega-AI-Platform" -ForegroundColor Green
