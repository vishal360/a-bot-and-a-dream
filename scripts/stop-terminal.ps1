# ABAD operator button: stops the paper terminal if it is running.
$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell
$say = { param($text) $sh.Popup($text, 8, 'A Bot and a Dream', 64) | Out-Null }
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $conn) { & $say 'The terminal is not running.'; exit 0 }
$procId = ($conn | Select-Object -First 1).OwningProcess
try { taskkill /PID $procId /T /F | Out-Null } catch { & $say "Could not stop process $procId : $($_.Exception.Message)"; exit 1 }
Start-Sleep -Seconds 2
$gone = -not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
if ($gone) { & $say "The terminal is stopped.`nRecording is paused - start it again anytime with the ABAD Start shortcut." }
else { & $say 'Something is still listening on port 3000; press Stop again or stop it manually.' }
