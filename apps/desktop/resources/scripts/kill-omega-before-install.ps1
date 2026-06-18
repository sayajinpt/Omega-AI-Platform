# Stop Omega and child processes before reinstalling (run as normal user; OK to elevate if needed).
$ErrorActionPreference = 'SilentlyContinue'

$names = @('Omega', 'omega-runtime', 'omega-ollama', 'omega-infer', 'llama-server')
foreach ($n in $names) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

$roots = @(
  "$env:LOCALAPPDATA\Programs\Omega",
  "${env:ProgramFiles}\Omega",
  "${env:ProgramFiles(x86)}\Omega"
)

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -and (
      ($_.Name -match '^(Omega|python|pythonw)\.exe$') -and (
        $roots | Where-Object { $_.ExecutablePath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }
      )
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2
Write-Host "Omega processes stopped. You can run the installer now."
