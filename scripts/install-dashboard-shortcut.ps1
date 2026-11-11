param([ValidateRange(1024,65535)][int]$Port = 3001)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'A Bot and a Dream Dashboard.lnk'
if (Test-Path -LiteralPath $path) { throw "Shortcut already exists: $path. Review/remove it manually before reinstalling." }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $root 'scripts\dashboard-control.ps1') + '" -Port ' + $Port
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Start, open or stop the local A Bot and a Dream dashboard (no trading authorization)'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output "Created: $path (port $Port)"
