# Quick status check - run anytime to see if 24h is alive and healthy
$root = "C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal"
Set-Location $root
Write-Host "=== BUN PROCESS ===" -ForegroundColor Cyan
Get-Process bun -ErrorAction SilentlyContinue | Format-Table Id,ProcessName,CPU,StartTime -AutoSize
if (-not (Get-Process bun -ErrorAction SilentlyContinue)) { Write-Host "NO BUN RUNNING - 24h is DEAD" -ForegroundColor Red }
Write-Host ""
Write-Host "=== LATEST run.json ===" -ForegroundColor Cyan
$latest = Get-ChildItem data/acceptance -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
  Write-Host "Run: $($latest.Name)  Updated: $($latest.LastWriteTime)" -ForegroundColor Gray
  Get-Content "data/acceptance/$($latest.Name)/run.json" | ConvertFrom-Json | Format-List version,startedAt,pid,requestedSeconds,phase,observationElapsedMs,warmupMs,state,healthy,complete,samplePassed,sustainedFeedAccepted,updatedAt
  $j = Get-Content "data/acceptance/$($latest.Name)/run.json" | ConvertFrom-Json
  Write-Host "Counts:" -ForegroundColor Gray
  $j.counts | Format-List
  $elapsed = [math]::Round($j.observationElapsedMs/1000)
  $pct = [math]::Round($elapsed/86400*100,2)
  $left = 86400 - $elapsed
  $hrs = [math]::Floor($left/3600); $mins = [math]::Floor(($left%3600)/60)
  $color = if ($j.healthy) { "Green" } else { "Red" }
  Write-Host "Progress: $elapsed / 86400s ($pct%)  |  healthy=$($j.healthy)  |  left ~ ${hrs}h ${mins}m" -ForegroundColor $color
  if ($j.complete) {
    Write-Host "COMPLETE - checking report.json" -ForegroundColor Green
    if (Test-Path "data/acceptance/$($latest.Name)/report.json") {
      Get-Content "data/acceptance/$($latest.Name)/report.json" | ConvertFrom-Json | Format-List sustainedFeedAccepted,samplePassed,healthyFraction,elapsedMs,failures
    }
  }
} else { Write-Host "No acceptance runs found" -ForegroundColor Red }
Write-Host ""
Write-Host "=== LAST LOG TAIL (20 lines) ===" -ForegroundColor Cyan
$log = Get-ChildItem data/acceptance/_logs*.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) { Write-Host "Log: $($log.Name)" -ForegroundColor Gray; Get-Content $log.FullName -Tail 20 } else { Write-Host "No _logs file (visible run has no log - watch the window)" -ForegroundColor Yellow }
Write-Host ""
Write-Host "=== HOW TO CHECK ===" -ForegroundColor Yellow
Write-Host "1. Is bun running?  -> Get-Process bun                (if missing, run is dead)"
Write-Host "2. Is run alive?    -> This script OR Get-Content data/acceptance/*/run.json"
Write-Host "3. Errors?          -> Watch the VISIBLE PowerShell window (open taskbar window)"
Write-Host "   If hidden run:   -> Get-Content data/acceptance/_logs-*.log -Tail 60"
Write-Host "   If visible run:  -> Errors print directly in that window"
Write-Host "4. Final result?    -> Get-Content data/acceptance/<id>/report.json  (only after 24h)"
