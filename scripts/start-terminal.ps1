# ABAD operator button: starts the paper terminal (localhost:3000) if it is not already running.
$ErrorActionPreference = 'Stop'
$proj = 'C:\Users\Awperation\.cline\data\workspaces\chat\trading-terminal'
$sh = New-Object -ComObject WScript.Shell
$say = { param($text) $sh.Popup($text, 8, 'A Bot and a Dream', 64) | Out-Null }
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conn) { & $say "The terminal is already running.`nOpen the dashboard: http://127.0.0.1:3000"; exit 0 }
try { Start-Process -FilePath 'bun' -ArgumentList 'run','src/server.ts' -WorkingDirectory $proj -WindowStyle Hidden } catch { & $say "Could not start bun: $($_.Exception.Message)"; exit 1 }
Start-Sleep -Seconds 7
$ok = $false
try { Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/readiness' -ErrorAction Stop | Out-Null; $ok = $true } catch {}
if ($ok) { & $say "The terminal is running.`nOpen the dashboard: http://127.0.0.1:3000`nRecording is on. Stop it anytime with the ABAD Stop shortcut." }
else { & $say "The terminal was started but has not answered yet.`nWait a few seconds and open http://127.0.0.1:3000`n(If it never comes up, press ABAD Stop and try again.)" }
