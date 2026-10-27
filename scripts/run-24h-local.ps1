# Local 24h resilient launcher - fixed path, power-cut survival
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = "C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal"
Set-Location $root
Write-Host "== w32time ensure ==" -ForegroundColor Cyan
sc.exe query w32time | Out-String | Write-Host
try { Start-Service w32time -ErrorAction SilentlyContinue } catch {}
try { Set-Service w32time -StartupType Automatic -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2
Write-Host "== w32tm status ==" -ForegroundColor Cyan
w32tm /query /status /verbose | Out-String | Write-Host
w32tm /query /peers | Out-String | Write-Host
Write-Host "== clock gate ==" -ForegroundColor Cyan
$bun = "C:/Users/Awperation/AppData/Local/Kiro-Cli/bun.exe"
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction Stop).Source }
& $bun run scripts/lighter-acceptance-clock.ts
if ($LASTEXITCODE -ne 0) { Write-Error "CLOCK NOT GREEN - fix w32time before starting 86400s"; exit 1 }
Write-Host "== starting 86400s run ==" -ForegroundColor Green
$ts = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$log = "data/acceptance/_logs-$ts.log"
$errLog = "data/acceptance/_logs-$ts.err.log"
New-Item -ItemType Directory -Force -Path "data/acceptance" | Out-Null
Write-Host "Logging to $log"
$proc = Start-Process -FilePath $bun -ArgumentList "run","scripts/accept-lighter.ts","--seconds","86400","--symbols","BTC,ETH" -RedirectStandardOutput $log -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
Write-Host "Started PID $($proc.Id)"
Write-Host "Monitor: Get-Content data/acceptance/*/run.json"
Write-Host "Tail: Get-Content $log -Wait -Tail 60"
$proc | Format-List Id,ProcessName,Path | Out-String | Write-Host
