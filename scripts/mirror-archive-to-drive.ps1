# Copy/check ONLY. A mounted Drive readback is NOT independent remote/offsite proof.
# Sensitive evidence encryption is not implemented. No local removal is performed.
param(
  [Parameter(Mandatory=$true)][string]$Vault,
  [Parameter(Mandatory=$true)][string]$Drive
)
$ErrorActionPreference = 'Stop'
function Assert-NoLinks([string]$Path) {
  $cursor = [System.IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Reparse/symlink path refused: $cursor" }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
Assert-NoLinks $Vault
Assert-NoLinks $Drive
$vaultRoot = [System.IO.Path]::GetFullPath($Vault).TrimEnd('\','/')
$driveRoot = [System.IO.Path]::GetFullPath($Drive).TrimEnd('\','/')
if ($driveRoot -eq $vaultRoot -or $driveRoot.StartsWith($vaultRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $vaultRoot.StartsWith($driveRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Source and destination must be distinct non-nested roots' }
if (-not (Test-Path -LiteralPath $vaultRoot -PathType Container)) { throw 'Vault must exist' }
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$folders = Get-ChildItem -LiteralPath $vaultRoot -Directory -Force | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and $_.Name -lt $today }
foreach ($dir in $folders) {
  Assert-NoLinks $dir.FullName
  # Validate all descendants before recursive enumeration can follow any link.
  $queue = [System.Collections.Generic.Queue[string]]::new()
  $queue.Enqueue($dir.FullName)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    foreach ($item in (Get-ChildItem -LiteralPath $current -Force)) {
      Assert-NoLinks $item.FullName
      if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
      $relative = $item.FullName.Substring($vaultRoot.Length + 1)
      $target = Join-Path $driveRoot $relative
      Assert-NoLinks $target
      $sourceHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $sourceHash) { throw "Existing destination mismatch: $relative (not overwritten)" }
      } else {
        Copy-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
      }
      $copy = Get-Item -LiteralPath $target
      if ($copy.Length -ne $item.Length -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $sourceHash) { throw "Mounted copy readback failed: $relative; local retained" }
      Write-Output "mounted-copy-readback-ok (NOT remote verified): $relative; local retained"
    }
  }
}
