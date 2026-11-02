#Requires -Version 5.1
<#
  Enables agent shadow mode for the running terminal, with persistence across
  restarts by default. Journal-only: agents record opinions, they never place
  orders. Execution latches stay session-only regardless.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-shadow.ps1
    ... -SessionOnly     (do not survive restarts)
    ... -Off             (disable shadow mode)
#>
param([switch]$SessionOnly, [switch]$Off)
$ErrorActionPreference = 'Stop'
$headers = @{ Origin = 'http://127.0.0.1:3000' }
try { Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/agents' -TimeoutSec 10 | Out-Null }
catch { throw 'The terminal is not running. Start it first (desktop ABAD Start, or scripts\start-terminal.ps1).' }

if ($Off) {
  $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/agents/disable' -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 15
  Write-Host ("Shadow mode DISABLED (enabled={0})." -f $status.enabled)
  return
}

$body = @{ confirm = 'ENABLE AGENT SHADOW'; persist = (-not $SessionOnly) } | ConvertTo-Json
$status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/agents/enable' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 15
Write-Host ("Shadow mode ENABLED (enabled={0}, survives restarts={1}). Journal-only: no orders." -f $status.enabled, $status.shadowPersist)
Write-Host ("Requests today: {0}/{1} - cycle every {2}s." -f $status.requests.used, $status.requests.cap, [int]($status.intervalMs / 1000))
