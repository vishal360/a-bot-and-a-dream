# Register auto-resume on reboot/logon - must run elevated (Run as Administrator)
# Creates a Task Scheduler entry that auto-starts w32time + clock check + 86400s run after powercut
$taskName = "LighterAcceptance24h"
$root = "C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal"
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = "$env:USERPROFILE\.bun\bin\bun.exe" }
Write-Host "bun = $bun"
Write-Host "root = $root"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -Command `"Set-Service w32time -StartupType Automatic; Start-Service w32time; Start-Sleep 10; w32tm /resync /force; Start-Sleep 5; Set-Location '$root'; & '$bun' run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH >> data/acceptance/_task-log.txt 2>&1`""
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggerBoot,$triggerLogon -Principal $principal -Settings $settings -Description "Lighter 86400s feed validation - resumes after power cut"
Write-Host "Registered task $taskName - verify with: Get-ScheduledTask $taskName | Format-List *"
Write-Host "Test now without reboot: Start-ScheduledTask -TaskName $taskName"
