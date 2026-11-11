param(
    [ValidateSet('Panel', 'Start', 'Stop', 'Status', 'Open')][string]$Action = 'Panel',
    [ValidateRange(1024,65535)][int]$Port = 3001,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Runtime = Join-Path $Root 'data\dashboard-launcher'
$StateFile = Join-Path $Runtime 'owner.json'
$Url = "http://127.0.0.1:$Port"

function Get-Owner {
    if (!(Test-Path -LiteralPath $StateFile)) { return $null }
    try {
        $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.processId)"
        if (!$process) { return $null }
        $started = (Get-Process -Id $process.ProcessId).StartTime.ToUniversalTime().Ticks.ToString()
        $expectedScript = Join-Path $Root 'src\server.ts'
        if ($state.root -ne $Root -or $state.startTicks -ne $started -or
            $process.ExecutablePath -ne $state.executable -or
            !$process.CommandLine.Contains($expectedScript)) { throw 'Ownership mismatch: refusing to control this process.' }
        return $state
    } catch { throw "Cannot verify dashboard ownership: $($_.Exception.Message)" }
}
function Test-Ready {
    try {
        $health = Invoke-RestMethod "$Url/api/health" -TimeoutSec 2
        return $health.status -eq 'ok' -and $health.liveTrading -eq $false
    } catch { return $false }
}
function Get-Status {
    $owner = Get-Owner
    if ($owner) { return "Managed dashboard PID $($owner.processId) on port $($owner.port)." }
    return 'Stopped (no dashboard owned by this launcher).'
}
function Start-Dashboard {
    $owner = Get-Owner
    if ($owner) {
        if ([int]$owner.port -ne $Port) { throw "Already running on port $($owner.port). Stop it before selecting another port." }
        if (!(Test-Ready)) { throw 'Managed process exists but is not healthy. Inspect logs or stop it first.' }
    } else {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        if ($listener) { throw "Port $Port is already occupied. This launcher will not replace or stop that application. Close it yourself or use a different port." }
        $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
        if (!(Test-Path -LiteralPath $bun)) {
            $command = Get-Command bun.exe -ErrorAction SilentlyContinue
            if (!$command) { throw 'Bun is not installed. Install Bun first; see the Windows launcher guide.' }
            $bun = $command.Source
        }
        if (!(Test-Path (Join-Path $Root 'node_modules'))) { throw 'Dependencies missing. Run bun install once in this checkout before using the launcher.' }
        # Rebuild on each cold start so a Git update cannot serve stale browser assets.
        & {
            $builder = Start-Process -FilePath $bun -ArgumentList @('run','build') -WorkingDirectory $Root -Wait -PassThru -NoNewWindow
            if ($builder.ExitCode -ne 0) { throw 'Dashboard build failed. See the console output.' }
        }
        New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
        $previousPort = $env:PORT
        try {
            $env:PORT = [string]$Port
            $child = Start-Process -FilePath $bun -ArgumentList @('run', ('"' + (Join-Path $Root 'src\server.ts') + '"')) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Runtime 'stdout.log') -RedirectStandardError (Join-Path $Runtime 'stderr.log')
        } finally { $env:PORT = $previousPort }
        $child.Refresh()
        $state = @{ processId=$child.Id; startTicks=$child.StartTime.ToUniversalTime().Ticks.ToString(); root=$Root; executable=$bun; port=$Port }
        $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            if (!(Get-Owner)) { throw 'Server exited during startup. Inspect data/dashboard-launcher/stderr.log.' }
            if (Test-Ready) { break }
            Start-Sleep -Milliseconds 300
        }
        if (!(Test-Ready)) { throw 'Startup timed out. The managed process is retained; inspect logs or use Stop.' }
    }
    if (!$NoBrowser) { Start-Process $Url }
    return "Dashboard ready at $Url. Starting the dashboard does not authorize trading."
}
function Stop-Dashboard {
    $owner = Get-Owner
    if (!$owner) { return 'Already stopped; no unrelated processes were touched.' }
    # Recheck ownership immediately before stopping. Never kill by image name or port.
    $verified = Get-Owner
    Stop-Process -Id ([int]$verified.processId) -ErrorAction Stop
    # Exact launcher-owned metadata path; never remove application databases or keys.
    if ([IO.Path]::GetFullPath($StateFile) -ne (Join-Path $Runtime 'owner.json')) { throw 'Unexpected metadata path' }
    Remove-Item -LiteralPath $StateFile -Force
    return 'Dashboard stopped. Local monitoring and alert delivery are offline until restarted.'
}
# Serialize CLI/panel actions across instances, including competing Start clicks.
function Invoke-Control([string]$Selected) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root))).Replace('-','') } finally { $sha.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Local\ABAD-$identity")
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw 'Another dashboard control action is busy.' }
        switch ($Selected) {
            'Start' { Start-Dashboard }
            'Stop' { Stop-Dashboard }
            'Status' { Get-Status }
            'Open' { if (!(Test-Ready)) { throw 'No healthy dashboard on the selected port. Start it first.' }; Start-Process $Url; "Opened $Url" }
        }
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
if ($Action -ne 'Panel') { Invoke-Control $Action; exit }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'A Bot and a Dream - Dashboard Control'
$form.Size = New-Object Drawing.Size(570,290)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$label = New-Object Windows.Forms.Label
$label.Location = New-Object Drawing.Point(20,20)
$label.Size = New-Object Drawing.Size(520,62)
$label.Text = "Local dashboard: $Url`r`nStarting does not enable trading. Stopping disables local monitoring."
$form.Controls.Add($label)
$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(20,155)
$status.Size = New-Object Drawing.Size(520,70)
$status.Text = Invoke-Control 'Status'
$form.Controls.Add($status)
$x = 20
foreach ($item in @(@('Start Dashboard','Start'), @('Open Dashboard','Open'), @('Stop Dashboard','Stop'))) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $item[0]; $button.Tag = $item[1]
    $button.Location = New-Object Drawing.Point($x,95)
    $button.Size = New-Object Drawing.Size(160,40)
    $button.Add_Click({
        param($sender,$event)
        if ($sender.Tag -eq 'Stop') {
            $answer = [Windows.Forms.MessageBox]::Show('Stop the dashboard? Local stops, monitoring and alert delivery cannot run while it is offline.', 'Confirm stop', 'YesNo', 'Warning')
            if ($answer -ne 'Yes') { return }
        }
        $form.Enabled = $false
        try { $status.Text = Invoke-Control $sender.Tag }
        catch { $status.Text = $_.Exception.Message; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Dashboard control', 'OK', 'Error') | Out-Null }
        finally { $form.Enabled = $true }
    })
    $form.Controls.Add($button); $x += 175
}
[void]$form.ShowDialog()
