# Visible 24h run - opens a new PowerShell window where you can SEE errors live
# Usage: powershell -ExecutionPolicy Bypass -File scripts/run-24h-visible.ps1
$root = "C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal"
$bun = "C:/Users/Awperation/AppData/Local/Kiro-Cli/bun.exe"
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction Stop).Source }
$inner = @'
Set-Location 'C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal'
Write-Host '=== CLOCK GATE ===' -ForegroundColor Cyan
w32tm /query /status /verbose
Write-Host ''
$bun = 'C:/Users/Awperation/AppData/Local/Kiro-Cli/bun.exe'
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction Stop).Source }
& $bun run scripts/lighter-acceptance-clock.ts
if ($LASTEXITCODE -ne 0) { Write-Host 'CLOCK FAILED - not starting' -ForegroundColor Red; pause; exit 1 }
Write-Host '=== CLOCK PASS - STARTING 86400s (24h) ===' -ForegroundColor Green
Write-Host 'KEEP THIS WINDOW OPEN. Close = kills the run.' -ForegroundColor Yellow
Write-Host ''
& $bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH
Write-Host ''
Write-Host ('EXIT CODE ' + $LASTEXITCODE) -ForegroundColor Cyan
pause
'@
Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner
Write-Host 'Opened visible 24h window - look for new PowerShell on taskbar' -ForegroundColor Green
Write-Host 'Errors will stream LIVE in that window. Do NOT close it.' -ForegroundColor Yellow
