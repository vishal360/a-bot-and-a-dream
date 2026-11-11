# Clickable Windows dashboard control

Double-click `Dashboard.cmd`, or use the **A Bot and a Dream Dashboard** desktop shortcut. The control panel has **Start Dashboard**, **Open Dashboard**, and **Stop Dashboard** buttons. Closing the panel leaves the server running; Stop explicitly stops it. Starting opens your default browser when ready.

Default URL: **http://127.0.0.1:3001**. Port 3001 avoids the existing original terminal on port 3000. This launcher starts this checkout's dashboard and its own `data` directory; it does not import, migrate, replace or stop the original checkout, and the two dashboards do not share account/history state.

## Initial requirements

Bun must be installed at `%USERPROFILE%\.bun\bin\bun.exe` or available on PATH. Run `bun install` once after a fresh clone. On this machine dependencies are already installed. Each cold start rebuilds the browser assets, then launches the local server hidden in the background. You do not need to type Bun commands on ordinary use.

To install a shortcut from another clone location, run once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-dashboard-shortcut.ps1
```

To choose another port, pass `-Port 3100` to the installer or control script. The installer refuses to overwrite an existing shortcut. Moving/deleting this checkout breaks its shortcut; reinstall it from the new location.

## Safety and ownership

- Start does **not** authorize trading or launch the 24-hour acceptance run. Normal server startup behavior applies, including any previously configured persistent shadow observers; execution latches remain session-only.
- Stop only targets the process recorded by this launcher after matching PID, start time, executable, absolute server script and checkout root. It never kills all Bun processes or kills by port.
- A port occupied by another server is refused, not taken over. You can still use Open for a healthy paper dashboard on the selected URL, but Stop will not claim it.
- **Stopping takes local monitoring, local stop/target evaluation, recording and alert delivery offline.** The Stop button asks for confirmation. This is a process stop, not a position-flattening action or exchange order cancellation. Never rely on a closed dashboard to protect exposure.
- Process termination is not a graceful drain. SQLite recovery and application restart reconciliation still apply; paper authorization must be deliberately restored after restart.
- A mutex serializes concurrent control actions. Failed/timed-out startup leaves the owned process tracked for inspection/Stop, not blindly relaunched.
- State/logs are stored in ignored `data/dashboard-launcher/owner.json`, `stdout.log` and `stderr.log`. No keys/DBs are deleted by Stop. Process ownership mismatch fails closed.

Optional command-line diagnostics (not needed for routine use):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dashboard-control.ps1 -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dashboard-control.ps1 -Action Start -NoBrowser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dashboard-control.ps1 -Action Stop
```

The Windows integration test uses a fresh temporary checkout and a fake local health server. It verifies foreign-port refusal, start, duplicate-start identity, status and idempotent Stop without running the actual trading dashboard or touching original data.
