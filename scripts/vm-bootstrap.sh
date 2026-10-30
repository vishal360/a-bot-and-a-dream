#!/usr/bin/env bash
# ABAD VM bootstrap: turns a fresh Ubuntu 22.04+ VM into the 24/7 recorder.
#
# Usage (on the VM, as root):
#   bash scripts/vm-bootstrap.sh [github-pat]
#
# - Works on any provider (Oracle/GCP/Hetzner/local). Needs ~512MB RAM minimum.
# - Creates swap (required on 1GB-RAM machines), installs chrony (disciplined
#   clock per docs/CLOUD_ACCEPTANCE.md) + Bun + rclone, clones the private repo
#   (a GitHub Personal Access Token with repo read access, or a deploy key),
#   runs the quality gate when the VM has RAM for it, and installs two systemd
#   units: abad-recorder (the app, always on) and abad-mirror (hourly rclone
#   move of data/archive into Google Drive, enabled once rclone is configured).
# - The app is paper-only and outbound-only: DO NOT open any inbound port.
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo bash scripts/vm-bootstrap.sh [github-pat]"; exit 1; fi
PAT="${1:-}"
REPO_URL="${REPO_URL:-https://github.com/vishal360/a-bot-and-a-dream.git}"
REPO_DIR="${REPO_DIR:-/opt/a-bot-and-a-dream}"
BRANCH="${BRANCH:-main}"

say() { echo ""; echo "==> $*"; }

say "1/7 swap file (required on small VMs)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap enabled"
else echo "swap already present"; fi

say "2/7 clock discipline (chrony) + git + rclone"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq chrony git curl rclone >/dev/null
systemctl enable --now chrony >/dev/null 2>&1 || true
chronyc tracking | head -n 3 || true

say "3/7 Bun runtime"
if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash; fi
export BUN_INSTALL="/root/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
echo "bun $(bun --version)"

say "4/7 repository"
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -n "$PAT" ]; then
    git clone "https://x-access-token:${PAT}@github.com/vishal360/a-bot-and-a-dream.git" "$REPO_DIR"
  else
    git clone "$REPO_URL" "$REPO_DIR"
  fi
fi
cd "$REPO_DIR"
git fetch origin "$BRANCH" >/dev/null 2>&1
git checkout "$BRANCH" >/dev/null 2>&1
git pull --ff-only origin "$BRANCH" >/dev/null 2>&1
echo "repo at $(git rev-parse --short HEAD) ($BRANCH)"

say "5/7 dependencies + quality gate"
bun install --frozen-lockfile
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM_MB" -ge 2000 ]; then
  bun run check && echo "gate green" || { echo "GATE FAILED - fix before trusting this VM"; exit 1; }
else
  echo "VM has ${TOTAL_RAM_MB}MB RAM: skipping the full gate (tsc+build are RAM-hungry)."
  echo "Run 'bun run check' once on a bigger box for the same commit; the recorder itself needs ~200MB."
fi

say "6/7 systemd: abad-recorder (always on, auto-restart)"
cat > /etc/systemd/system/abad-recorder.service <<'UNIT'
[Unit]
Description=ABAD recorder (paper-only, outbound-only; docs/CLOUD_ACCEPTANCE.md)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/a-bot-and-a-dream
ExecStart=/root/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now abad-recorder
sleep 3
systemctl is-active abad-recorder && echo "recorder ACTIVE" || { echo "recorder FAILED - journalctl -u abad-recorder -n 30"; exit 1; }

say "7/7 systemd: abad-mirror (hourly rclone move into Google Drive)"
cat > /etc/systemd/system/abad-mirror.service <<'UNIT'
[Unit]
Description=ABAD archive mirror: rclone move data/archive -> Google Drive
ConditionPathExists=/root/.config/rclone/rclone.conf

[Service]
Type=oneshot
ExecStart=/usr/bin/rclone move /opt/a-bot-and-a-dream/data/archive gdrive:ABAD-archive --min-age 2h
UNIT
cat > /etc/systemd/system/abad-mirror.timer <<'UNIT'
[Unit]
Description=Run the ABAD archive mirror hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
if rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  systemctl enable --now abad-mirror.timer
  echo "mirror timer ENABLED (gdrive remote found)"
else
  echo "mirror timer NOT enabled yet: configure rclone first (one-time, 5 minutes):"
  echo "  1. On a machine WITH a browser:  rclone authorize \"drive\""
  echo "     (install rclone there first; it prints a config token block)"
  echo "  2. Paste that block into /root/.config/rclone/rclone.conf on this VM as:"
  echo '     [gdrive]'
  echo '     type = drive'
  echo '     <token block lines>'
  echo "  3. Then: systemctl enable --now abad-mirror.timer"
  echo "Until then, archives simply accumulate in data/archive (the app never blocks)."
fi

say "DONE. Next steps (docs/CLOUD_ACCEPTANCE.md):"
echo "  - let the recorder run, then the 24h acceptance:"
echo "    tmux new -s accept"
echo "    bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH"
echo "  - after 24h: bun run scripts/inspect-lighter-acceptance.ts <run-uuid> && read report.json"
echo "  - the Word-guide/Drive mirror on your PC is unaffected; this VM records 24/7."
