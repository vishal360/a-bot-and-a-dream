# ABAD archive mirror: moves completed UTC day-folders from the local vault into Google Drive.
# Designed to run hourly via Task Scheduler. Today's folder is never moved (still recording).
# Fail-safe: if Drive is offline, robocopy leaves files in place and the next run retries;
# the trading app never depends on this job to function.
$ErrorActionPreference = 'Stop'
$vault = 'C:\Users\Awperation\.cline\data\workspaces\chat\trading-terminal\data\archive'
$drive = 'G:\My Drive\ABAD-archive'
$log = Join-Path $vault 'mirror.log'
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content -Path $log }
try {
  if (-not (Test-Path $drive)) { New-Item -ItemType Directory -Path $drive -Force | Out-Null; Log "created drive folder $drive" }
  New-Item -ItemType Directory -Path $drive -Force | Out-Null
  $today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
  $folders = Get-ChildItem $vault -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and $_.Name -lt $today }
  foreach ($dir in $folders) {
    $target = Join-Path $drive $dir.Name
    robocopy $dir.FullName $target /MOVE /E /NFL /NDL /NJH /NJS /R:2 /W:5 | Out-Null
    if ($LASTEXITCODE -le 7) {
      Remove-Item $dir.FullName -Force -ErrorAction SilentlyContinue
      Log "moved $($dir.Name) -> $target"
    } else {
      Log "robocopy problem for $($dir.Name) (exit $LASTEXITCODE); will retry next run"
    }
  }
  Log "mirror cycle done"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
