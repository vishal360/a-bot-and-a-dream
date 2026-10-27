# 24h read-only Lighter acceptance launcher (visible window, live log, sleep guard).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-24h.ps1
#
# 1. Waits until the SAME clock gate the observer uses (scripts/lighter-acceptance-clock.ts)
#    passes AND root dispersion is below 1s (a calm clock, not a tolerated post-sync spike).
# 2. Keeps the PC awake while this window is open (SetThreadExecutionState). It cannot
#    survive a power cut - nothing local can.
# 3. Runs the observer in THIS window, mirrors all output to data/acceptance/_live-<time>.log
#    and records data/acceptance/_active.json so `scripts/scan-24h.ts` knows which run is current.
# Never changes Windows Time configuration and never places orders.
param([int]$Seconds = 86400, [string]$Symbols = 'BTC,ETH', [int]$MaxWaitMinutes = 90)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$bun = 'C:/Users/Awperation/AppData/Local/Kiro-Cli/bun.exe'
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction Stop).Source }
$Host.UI.RawUI.WindowTitle = "LIGHTER 24H ACCEPTANCE - DO NOT CLOSE"

Add-Type -Namespace Dream -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no idle sleep while this process lives (display may still turn off).
[void][Dream.Power]::SetThreadExecutionState([uint32]2147483649)

Write-Host '=== LIGHTER 24H ACCEPTANCE (read-only, no orders) ===' -ForegroundColor Cyan
Write-Host "Root: $root  |  $Seconds s  |  $Symbols" -ForegroundColor Gray
Write-Host 'Sleep guard ON while this window is open. Closing this window ends the run.' -ForegroundColor Yellow

$deadline = (Get-Date).AddMinutes($MaxWaitMinutes); $attempt = 0
while ($true) {
  $attempt++
  $json = & $bun run scripts/lighter-acceptance-clock.ts 2>$null | Out-String
  $clock = $null; try { $clock = $json | ConvertFrom-Json } catch {}
  if ($clock) {
    $calm = $clock.passed -and $clock.rootDispersionSeconds -ne $null -and $clock.rootDispersionSeconds -lt 1.0 -and $clock.syncAgeSeconds -lt 2400
    $msg = "Clock #$attempt $(Get-Date -Format HH:mm:ss): passed=$($clock.passed) unc=$([math]::Round($clock.uncertaintyMs))ms disp=$($clock.rootDispersionSeconds)s age=$([math]::Round($clock.syncAgeSeconds))s err=$($clock.lastSyncError) src=$($clock.source)"
    if ($calm) { Write-Host "$msg -> GREEN" -ForegroundColor Green; break }
    Write-Host "$msg -> waiting (need passed, dispersion<1s, age<2400s)" -ForegroundColor Yellow
    if ($clock.failures) { $clock.failures | ForEach-Object { Write-Host "   - $_" -ForegroundColor DarkYellow } }
  } else { Write-Host "Clock #$attempt : unreadable clock output" -ForegroundColor Red }
  if ((Get-Date) -gt $deadline) { Write-Host 'Clock never became calm. Admin fix: net stop w32time; net start w32time; w32tm /resync /force' -ForegroundColor Red; Read-Host 'Enter to close'; exit 1 }
  Start-Sleep -Seconds 60
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$log = Join-Path $root "data/acceptance/_live-$stamp.log"
$before = @(Get-ChildItem data/acceptance -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
$active = [ordered]@{ launchedAt = (Get-Date).ToUniversalTime().ToString('o'); launcherPid = $PID; seconds = $Seconds; symbols = $Symbols; log = "data/acceptance/_live-$stamp.log"; runId = $null }
$active | ConvertTo-Json | Set-Content data/acceptance/_active.json -Encoding UTF8

# Background job: once the observer creates its directory, record the run id for scan-24h.ts.
$null = Start-Job -ArgumentList $root, $before -ScriptBlock {
  param($root, $before)
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 2
    $new = Get-ChildItem (Join-Path $root 'data/acceptance') -Directory | Where-Object { $before -notcontains $_.Name } | Sort-Object CreationTime -Descending | Select-Object -First 1
    if ($new) {
      $path = Join-Path $root 'data/acceptance/_active.json'
      $a = Get-Content $path -Raw | ConvertFrom-Json; $a.runId = $new.Name
      $a | ConvertTo-Json | Set-Content $path -Encoding UTF8; return
    }
  }
}

Write-Host ''
Write-Host "=== STARTING $Seconds s OBSERVATION $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Green
Write-Host "Live log: $log" -ForegroundColor Gray
Write-Host 'Status any time (other window): bun run scripts/scan-24h.ts' -ForegroundColor Gray
Write-Host ''
$ErrorActionPreference = 'Continue'
& $bun run scripts/accept-lighter.ts --seconds $Seconds --symbols $Symbols 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log
$code = $LASTEXITCODE
[void][Dream.Power]::SetThreadExecutionState([uint32]2147483648)
Write-Host ''
Write-Host "=== OBSERVER EXITED code=$code at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Cyan
& $bun run scripts/scan-24h.ts
Read-Host 'Press Enter to close'
