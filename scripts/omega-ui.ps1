# Terminal UI helpers for Omega Windows build (dot-source from build-windows.ps1).
# ASCII-only strings for Windows PowerShell 5.1 compatibility.

$script:OmegaUiRoot = Split-Path -Parent $PSScriptRoot
$script:OmegaBannerFile = Join-Path $OmegaUiRoot "apps\desktop\resources\omega-banner.txt"
$script:BrandName = [char]937 + 'mega'

function Get-OmegaWidth {
    if ($Host.UI.RawUI.WindowSize.Width -gt 0) { [Math]::Min(80, $Host.UI.RawUI.WindowSize.Width) } else { 60 }
}

function Clear-OmegaScreen {
    try { [Console]::Clear() } catch { Write-Host "" }
}

function Write-OmegaBanner {
    param([string]$Title = "")
    Clear-OmegaScreen
    Write-Host ""
    if (Test-Path $script:OmegaBannerFile) {
        Get-Content $script:OmegaBannerFile -Encoding UTF8 | ForEach-Object {
            Write-Host $_ -ForegroundColor Magenta
        }
    } else {
        Write-Host "  $($script:BrandName) - Local AI Operating System" -ForegroundColor Cyan
    }
    Write-Host ""
    if ($Title) {
        Write-Host $Title -ForegroundColor White
        Write-Host ('-' * (Get-OmegaWidth)) -ForegroundColor DarkGray
        Write-Host ""
    }
}

function Write-OmegaLog {
    param(
        [ValidateSet('ok', 'run', 'warn', 'err', 'info')]
        [string]$Level = 'info',
        [Parameter(Mandatory)][string]$Message
    )
    $prefix = '[..]'
    $color = 'DarkGray'
    switch ($Level) {
        'ok' { $prefix = '[ok]'; $color = 'Green' }
        'run' { $prefix = '[>>]'; $color = 'Cyan' }
        'warn' { $prefix = '[!!]'; $color = 'Yellow' }
        'err' { $prefix = '[xx]'; $color = 'Red' }
    }
    Write-Host "$prefix $Message" -ForegroundColor $color
}

function Write-OmegaStep {
    param(
        [int]$Current,
        [int]$Total,
        [string]$Label
    )
    Write-Host ""
    Write-Host "[$Current/$Total] $Label" -ForegroundColor Cyan
    Write-OmegaLog -Level run -Message 'starting...'
}

function Write-OmegaProgressBar {
    param([int]$Percent = 0)
    $width = 40
    $filled = [Math]::Floor($Percent * $width / 100)
    $empty = $width - $filled
    $bar = ('#' * $filled) + ('.' * $empty)
    Write-Host "[$bar] $Percent%" -ForegroundColor Magenta
}

function Start-OmegaBootSequence {
    param([string]$Mode = 'build')
    Write-OmegaLog -Level info -Message "kernel: omega-build-$Mode"
    Start-Sleep -Milliseconds 80
    Write-OmegaLog -Level ok -Message 'terminal ui loaded'
    Start-Sleep -Milliseconds 60
    Write-OmegaLog -Level ok -Message "manifest: $($script:BrandName) local AI OS"
    Start-Sleep -Milliseconds 50
}

function Write-OmegaSuccess {
    Write-Host ""
    Write-OmegaProgressBar -Percent 100
    Write-Host ""
    Write-Host '+======================================+' -ForegroundColor Green
    Write-Host '|  BUILD SUCCEEDED                     |' -ForegroundColor Green
    Write-Host '+======================================+' -ForegroundColor Green
    Write-Host ""
}

function Write-OmegaFail {
    Write-Host ""
    Write-Host '+======================================+' -ForegroundColor Red
    Write-Host '|  BUILD FAILED                        |' -ForegroundColor Red
    Write-Host '+======================================+' -ForegroundColor Red
    Write-Host ""
}
