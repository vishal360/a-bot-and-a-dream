#Requires -Version 5.1
<#
  Writes TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID into the repo .env (git-ignored),
  restarts the terminal so the server picks them up, and optionally sends a test
  alert. The token is never echoed back to the console and other keys are kept.

  Usage (from anywhere):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-telegram.ps1 -Test
  Prompts for the two values when -Token / -ChatId are omitted.
#>
param(
  [string]$Token,
  [string]$ChatId,
  [string]$EnvPath,
  [switch]$Test,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $EnvPath) { $EnvPath = Join-Path $repo '.env' }

if (-not $Token) {
  Write-Host 'Paste the bot token from @BotFather (looks like 123456789:AA...). Input is hidden.'
  $secure = Read-Host -AsSecureString 'TELEGRAM_BOT_TOKEN'
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $ChatId) {
  Write-Host 'Paste your numeric chat id (from @userinfobot; -100... for a group).'
  $ChatId = (Read-Host 'TELEGRAM_CHAT_ID').Trim()
}

$Token = $Token.Trim(); $ChatId = $ChatId.Trim()
if ($Token -notmatch '^\d{6,}:[A-Za-z0-9_-]{25,}$') { throw 'That does not look like a Telegram bot token (expected <digits>:<chars>).' }
if ($ChatId -notmatch '^-?\d{5,}$') { throw 'That does not look like a Telegram chat id (digits, optionally leading -).' }

# Read existing .env, preserving every other key and its order.
$lines = New-Object System.Collections.Generic.List[string]
if (Test-Path $EnvPath) { foreach ($l in (Get-Content $EnvPath)) { $lines.Add([string]$l) } }

function Set-EnvLine {
  param([System.Collections.Generic.List[string]]$List, [string]$Key, [string]$Value)
  $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
  $found = $false
  for ($i = 0; $i -lt $List.Count; $i++) {
    if ($List[$i] -match $pattern) { $List[$i] = "$Key=$Value"; $found = $true }
  }
  if (-not $found) { $List.Add("$Key=$Value") }
}

Set-EnvLine -List $lines -Key 'TELEGRAM_BOT_TOKEN' -Value $Token
Set-EnvLine -List $lines -Key 'TELEGRAM_CHAT_ID' -Value $ChatId
[System.IO.File]::WriteAllLines($EnvPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to $EnvPath (token not displayed; other keys kept)."

if ($NoRestart) { Write-Host 'Skipped restart (-NoRestart): the server only sees new keys after a restart.'; return }

Write-Host 'Restarting the terminal so the alerter picks up the keys...'
& (Join-Path $repo 'scripts\stop-terminal.ps1') | Out-Null
Start-Sleep -Seconds 2
& (Join-Path $repo 'scripts\start-terminal.ps1') | Out-Null
Start-Sleep -Seconds 8

try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/alerts' -TimeoutSec 10 }
catch { throw "Could not reach /api/alerts after restart: $($_.Exception.Message)" }
Write-Host ("Alerting configured: {0}" -f $status.configured)
if (-not $status.configured) { throw 'Server started but reports alerting NOT configured - check .env.' }

if ($Test) {
  $headers = @{ Origin = 'http://127.0.0.1:3000' }
  $result = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/alerts/test' -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 20
  if ($result.ok) { Write-Host 'Test alert SENT - check your phone.' } else { throw "Test alert failed: $($result.error)" }
}
