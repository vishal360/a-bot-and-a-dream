# Cloud acceptance run — runbook

The October 26 24h observation failed on the desktop host (97.64% healthy vs
99% required, 222s worst outage vs 30s policy, 2.4s feed-clock drift vs 2s, 456
disconnects vs 216 budget — with **zero sequence gaps and zero recording
failures**). The pipeline is clean; the host is not. Do not assume a VM passes —
expect it to, and verify once. The run costs nothing but wall-clock time.

## Why not assume

Assuming is the loosened-threshold mindset the clock fix just removed. The gate
is evidence, and one 24h run on a disciplined host converts "should pass" into
"is accepted". A VM removes the two observed failure causes: consumer-network
disconnects and an undisciplined Windows clock.

## One-time VM setup (Oracle Cloud free tier, Ubuntu)

1. Create an Always-Free VM (A1 Flex, 1-2 OCPU, Ubuntu 22.04+). Open outbound only; **do not** open any inbound port — the observer is outbound-only.
2. SSH in, then:

```bash
curl -fsSL https://bun.sh/install | bash          # Bun 1.4+
sudo apt-get update && sudo apt-get install -y chrony   # disciplined clock
sudo timedatectl set-ntp true
chronyc tracking                                   # verify sync before the run
```

3. Clone the repository (private): `git clone git@github.com:vishal360/a-bot-and-a-dream.git && cd a-bot-and-a-dream`
4. `bun install --frozen-lockfile && bun run check` — the gate must be green on the VM too.

## The run

```bash
bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH
```

- Run it inside `tmux`/`screen` or with `nohup` so SSH drops do not abort it.
- The run is read-only public market data: no keys, no account access.
- Note the VM's timezone/UTC drift in your head, not in the evidence: the report
  measures publication-vs-host offsets itself.

## After 24 hours

1. `bun run scripts/inspect-lighter-acceptance.ts <run-uuid>` and read `report.json`:
   `samplePassed`, `sustainedFeedAccepted`, `healthyFraction`, `longestUnhealthyMs`,
   `maximumClockDriftMs`, disconnect counts.
2. Copy `data/acceptance/<uuid>/report.json` back to the desktop and record the
   result in `docs/AUTOMATION_ROADMAP.md` + `uptill.txt`.
3. A PASS satisfies the sustained-feed gate for the current criteria. A FAIL is
   diagnostic evidence, never silently retried with changed thresholds.
