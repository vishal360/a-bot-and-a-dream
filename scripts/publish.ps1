$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
# Read the existing Windows Git credential in memory only. Never print or persist it.
$env:GCM_INTERACTIVE = 'Never'
$credential = "protocol=https`nhost=github.com`nusername=vishal360`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'No usable GitHub credential. Authenticate GitHub before publishing.' }
$passwordLine = $credential | Where-Object { $_.StartsWith('password=') } | Select-Object -First 1
if (-not $passwordLine) { throw 'Git credential did not contain a token.' }
$token = $passwordLine.Substring(9)
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'a-bot-and-a-dream-publisher' }
$user = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers
$owner = $user.login
$name = 'a-bot-and-a-dream'
try {
  $repo = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$name" -Headers $headers
} catch {
  if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
  $body = @{ name = $name; description = 'A Bot and a Dream — paper-first futures and crypto research terminal'; private = $true; auto_init = $false } | ConvertTo-Json
  $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
}
if (-not $repo.private) { throw 'Existing repository is public; refusing to publish without review.' }
if (-not (Test-Path '.git')) { git init -b main; if ($LASTEXITCODE -ne 0) { throw 'git init failed' } }
git config user.name $owner
git config user.email "$($user.id)+$owner@users.noreply.github.com"
git add .
git diff --cached --quiet
if ($LASTEXITCODE -eq 1) { git commit -m 'Build paper-first trading terminal, research lab, risk controls and tests'; if ($LASTEXITCODE -ne 0) { throw 'Commit failed' } }
$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) { git remote add origin $repo.clone_url } elseif ($existing -ne $repo.clone_url) { throw 'Unexpected origin; refusing to overwrite it.' }
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'Push failed' }
Write-Output "PUBLISHED=$($repo.html_url)"
$token = $null; $headers = $null; $credential = $null; $passwordLine = $null