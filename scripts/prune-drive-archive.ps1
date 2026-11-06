#Requires -Version 5.1
<#
  Drive retention pruner (docs/DATA_ENGINE.md): enforces the operator's 6-month
  retention policy on the ABAD Archive Mirror. DRY-RUN BY DEFAULT: without -Apply
  it only prints what would be deleted. With -Apply it deletes the matching day
  folders and appends one summary line to the mirror log (the health watchdog
  only parses "mirror cycle done" lines, so prune lines never confuse it).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prune-drive-archive.ps1            # dry run
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prune-drive-archive.ps1 -Apply     # actually delete
    ... -Months 6 -DriveRoot "G:\My Drive\ABAD-archive"
#>
param(
  [switch]$Apply,
  [int]$Months = 6,
  [string]$DriveRoot = 'G:\My Drive\ABAD-archive',
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
if ($Months -lt 1 -or $Months -gt 120) { throw '-Months must be 1..120' }
if (-not (Test-Path $DriveRoot)) { throw "Drive root not found: $DriveRoot" }
if (-not $LogPath) { $LogPath = Join-Path $DriveRoot 'prune.log' }

$cutoff = (Get-Date).ToUniversalTime().AddMonths(-$Months)
$targets = @()
foreach ($dir in (Get-ChildItem $DriveRoot -Directory | Sort-Object Name)) {
  # Only pure UTC day folders (YYYY-MM-DD) are prunable; anything else is never touched.
  if ($dir.Name -notmatch '^\d{4}-\d{2}-\d{2}$') { continue }
  $day = [datetime]::ParseExact($dir.Name, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture).ToUniversalTime()
  if ($day -lt $cutoff) { $targets += $dir }
}

$mode = if ($Apply) { 'APPLY' } else { 'DRY-RUN' }
Write-Host ("[{0}] prune-drive-archive: cutoff {1:yyyy-MM-dd}, {2} folder(s) older than {3} month(s)" -f $mode, $cutoff, $targets.Count, $Months)
foreach ($t in $targets) {
  $sizeMb = [math]::Round((Get-ChildItem $t.FullName -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
  if ($Apply) {
    Remove-Item $t.FullName -Recurse -Force
    Write-Host ("  deleted {0} ({1} MB)" -f $t.Name, $sizeMb)
    Add-Content -Path $LogPath -Value ("{0} pruned {1} ({2} MB, policy {3} months)" -f (Get-Date).ToUniversalTime().ToString('o'), $t.Name, $sizeMb, $Months)
  } else {
    Write-Host ("  would delete {0} ({1} MB)" -f $t.Name, $sizeMb)
  }
}
if ($Apply -and -not $targets.Count) { Write-Host 'Nothing to prune.' }
if (-not $Apply) { Write-Host 'Dry run only - pass -Apply to delete.' }
