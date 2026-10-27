# Visible 24h with CLOCK WAIT - polls until GREEN then launches 86400s
# Exactly like run-24h-visible.ps1 but waits for dispersion spike to settle
$inner = @'
Set-Location 'C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal'
$bun = 'C:/Users/Awperation/AppData/Local/Kiro-Cli/bun.exe'
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction Stop).Source }
Write-Host '=== 24h VISIBLE LAUNCHER (with CLOCK WAIT) ===' -ForegroundColor Cyan
Write-Host 'Killed old run d59c004e (6.4h) - starting FRESH 86400s BTC,ETH' -ForegroundColor Gray
Write-Host 'Clock policy: stratum 1-15, syncAge <3600s, uncertainty <2000ms' -ForegroundColor Gray
Write-Host ''
$attempt = 0
while ($true) {
  $attempt++
  Write-Host "--- Clock check #$attempt : $(Get-Date -Format 'HH:mm:ss') ---" -ForegroundColor Yellow
  w32tm /query /status /verbose
  Write-Host ''
  & $bun run scripts/lighter-acceptance-clock.ts
  if ($LASTEXITCODE -eq 0) {
    Write-Host '=== CLOCK GREEN - PASS ===' -ForegroundColor Green
    break
  }
  Write-Host 'CLOCK RED - waiting 90s for dispersion to settle...' -ForegroundColor Red
  Write-Host 'Fix (Admin): Restart-Service w32time; w32tm /resync /force; w32tm /query /status /verbose' -ForegroundColor DarkYellow
  Write-Host 'Next poll in 90s (poll interval 1024s, next sync ~11:47). Leave this window open.' -ForegroundColor Gray
  Write-Host ''
  Start-Sleep -Seconds 90
  if ($attempt -ge 40) { Write-Host 'Gave up after 40 tries (~60min) - clock still RED. Check w32time.' -ForegroundColor Red; pause; exit 1 }
}
Write-Host ''
Write-Host '=== STARTING 86400s (24h) BTC,ETH ===' -ForegroundColor Green
Write-Host 'KEEP THIS WINDOW OPEN. Close = kills the run. Errors stream LIVE here.' -ForegroundColor Yellow
Write-Host ''
& $bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH
Write-Host ''
Write-Host ('EXIT CODE ' + $LASTEXITCODE) -ForegroundColor Cyan
if (Test-Path 'data/acceptance/*/report.json') {
  Write-Host '--- report.json ---' -ForegroundColor Green
  Get-Content data/acceptance/*/report.json | Select-Object -First 80
}
pause
'@
Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner
Write-Host 'Opened VISIBLE 24h WAIT window - check taskbar for new PowerShell' -ForegroundColor Green
Write-Host 'It will poll clock every 90s until GREEN, then auto-start 86400s. Leave it open.' -ForegroundColor Yellow
