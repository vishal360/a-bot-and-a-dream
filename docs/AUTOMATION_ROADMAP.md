# Automation roadmap — no order automation approval yet

This is the current implementation/evidence checklist, not a trading authorization.
Builds and unit tests establish software behavior, not profitable or safe trading.
All work remains inside the local paper/read-only boundary. Real-money signing is
not implemented and cannot be enabled through a readiness flag.

## Shipped foundation

- Validated integer WebSocket depth/stats, snapshot recovery and fail-closed recording.
- Public trades, bounded snapshot-rooted capture export and deterministic offline replay.
- Manual/protection IOC authority, durable reservations, atomic fill/release, restart fencing.
- Baseline provenance records, fixed-capital flat-at-midnight reconstruction and fail-closed
  corruption handling. Read-only inspection: `GET /api/paper/risk-days`.
- Bounded mainnet feed acceptance runner and an explicit automation-blocker report
  at `GET /api/readiness`. Neither enables agents or orders.

## Risk-day semantics

New records are immutable and checksummed. With no position at the UTC boundary,
the local fill ledger reconstructs opening cash, including previously charged fees
and realized P&L. This verifies **only the implemented fixed-capital paper model**.
The later [perpetual accounting increment](PAPER_PERPETUAL_ACCOUNTING.md) adds
signed inventory, delayed funding and approximate liquidation. It is still not
venue-certified perpetual equity: funding timestamp semantics, liquidation
calibration and exact overnight UTC baseline evidence remain open.

A session created during a day uses known starting capital and is labeled
`session-inception`, not midnight equity. An overnight open position without a
verified boundary mark retains `first-observed` semantics, never backfills a later
mark as midnight. Legacy baselines are preserved and labeled `legacy-unverified`;
upgrading software does not improve their provenance or alter their economics.
No deposit/withdrawal/capital-change endpoint exists. New transfers require an
immutable cash-flow ledger before this model can be extended.

Corrupted/conflicting evidence latches new exposure off; RESET does not clear it.
Ledger-verified reductions remain possible with fresh executable data. There is
no HTTP baseline editing or reset endpoint. There is now a narrowly scoped, explicit
delayed-funding reconciliation endpoint: it preserves the baseline, verifies the
original flat ledger and never lowers the effective loss threshold. It cannot clear
corruption/overnight evidence problems or unrelated risk halts. Hashes detect accidental modification;
local administrators can alter the database and hashes, so they are not attestations.

## Read-only mainnet acceptance

From `C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal`:

```powershell
bun run scripts/accept-lighter.ts --seconds 60 --symbols BTC,ETH
bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH
```

Each run creates an isolated SQLite database, capture exports and `report.json`
under `data/acceptance/<uuid>/`. It does not open the operator account database,
import Paper, submit intents, hold credentials or write fills. Duration is bounded
to 60 seconds–24 hours and the watch universe to four markets. Stop the CLI process
to abort; an interrupted run without a final report is not acceptance evidence.

Version-1 engineering feed criteria are declared before observing results:
30-second snapshot/stats warmup, 24-hour observed duration, at least 99% observed
healthy time, no unhealthy interval over 30 seconds, no sampling gap over 2.5
seconds, no clock drift over 2 seconds, zero durable recording failures, public
trades observed for every watched market and valid rooted book/stats replay.
These thresholds are engineering defaults, **not approved strategy risk policy**.
Startup warmup is reported separately from the measurement window. Large sampling
gaps count as unhealthy, never assumed healthy. A disconnect-counter increase also
marks the interval unhealthy even if the feed recovered before the next sample;
counter regression latches an integrity failure. Short samples may pass their sample
checks but cannot satisfy the sustained criterion. Captures remain bounded prefixes,
not a 24-hour replay archive, and trade continuity remains unproven.

## Observed host-clock blocker (2026-10-12)

The initial BTC/ETH sample reached public mainnet metadata and WebSocket market
stats, but publications arrived about 2.21 seconds **ahead** of host receive time.
This violated the unchanged two-second future tolerance and prevented healthy
warmup. The recorded Windows `w32tm /query /status` response was "The service has
not been started" (`0x80070426`). This suggests host time synchronization needs
operator attention; the observation alone does not prove which clock is wrong.
No OS service/time configuration was changed. Synchronize Windows time through
the normal administrator controls, verify it against a trusted time source, then
rerun the short sample before attempting the 24-hour run. Never offset incoming
timestamps or widen the threshold just to obtain a passing result.

Evidence is in the ignored `roadmap-mainnet-*.log`, `roadmap-clock.log`,
`roadmap-windows-clock.log` and isolated `data/acceptance/` reports. The repeated
sample also failed warmup with a reported publication age of -2199 ms. Neither
failed sample is sustained feed acceptance.

A later read-only recheck (2026-10-12 15:26 UTC) found the service running with
manual start but still unsynchronized: `Leap Indicator: 3`, `Source: Local CMOS
Clock` and no successful sync time. Nine HTTPS `cdn-cgi/trace` probes reported
Cloudflare's clock 1.06–1.34 seconds ahead of the host (20–80 ms round trip). So
roughly half of the earlier ~2.2-second Lighter offset is consistent with a slow
host clock. The remainder is unexplained, and the two measurements were hours
apart. That probe is approximate and is not a trusted time source. Evidence is in
the ignored `roadmap-final-clock-offset.log`. No configuration was changed.

## Latest software validation

The manual recovery/display increment adds explicit baseline reconciliation and
stale/display-only retained quotes. A new 60-second isolated BTC/ETH mainnet sample
completed at local evidence time 2026-10-12 21:41:37 UTC: 100% observed health, zero
disconnects/gaps/invalid frames/recording failures and valid rooted replay. It supersedes
the older failed short samples **for that interval only**. It does not prove clock
synchronization, sustained acceptance or historical funding eligibility/finality.
The next evidence work is recorded in [funding evidence](LIGHTER_FUNDING_EVIDENCE.md).
Local log timestamps still differ from the session's stated date; do not infer
trusted UTC synchronization from them.

The latest clean `verify-paper-accounting.ts` run completed at local evidence time
2026-10-12 21:50:53 UTC, after the patches: TypeScript, 152 unit tests (1,094 assertions),
production build and six desktop/mobile Edge workflows all exited 0. Staged whitespace
checks passed. The older 128-test result below is historical, not this increment.

`bun run scripts/verify-lighter-evidence.ts` completed at 2026-10-12 11:02 UTC,
after the last source edit. All stages exited 0: TypeScript, **128 tests across
17 files** (936 assertions), production build, four desktop/mobile-sized Edge
workflows, HTTP/static smoke and `git diff --check`. `git diff --check` skips
untracked files, so the new untracked files were scanned separately for trailing
whitespace and mixed line endings; none were found. This is software validation
only. It is not mainnet feed acceptance.

## Remaining dependency order

1. Resolve real-runtime feed/clock faults without weakening timestamp/sequence rules;
   complete the sustained read-only run and record disconnect/restore/recording drills.
2. Complete perpetual accounting: settled hourly funding with source provenance,
   signed inventory, fees, cross/isolated margin policy, maintenance margin and
   conservative liquidation/insolvency handling. Never settle projected funding.
3. Complete overnight UTC-boundary marks, cash-flow provenance, session archival,
   accounting/recovery migration and central risk reconciliation.
4. Freeze an exact strategy artifact and data/evaluation policy. Record provenance,
   leakage controls, untouched holdout and walk-forward comparisons to baselines.
5. Add an isolated **shadow-only** worker with typed proposals, resource limits,
   expiry, audit and no write access to trading state or keys; run paper-forward evidence.
6. After explicit bounded paper promotion, connect proposals to the same central
   reservations/executor with account/per-symbol/order-frequency limits, kill and
   restart drills. No alternate fill/reservation path.
7. Real-money trading is a separate project/gate: eligibility, adapter conformance,
   signer isolation, reconciliation, operational security and explicit capital approval.

Resting limits are not needed for an IOC-only initial strategy. If a strategy needs
them, conservative queue, public-trade coverage, cancel/fill races and maker fees
become prerequisites; quote touches cannot stand in for fills.

An approved strategy, fee tier, permitted markets/order types, leverage/exposure/
loss policy, holding horizon, deployment/alert requirements and forward-test
criteria are still required before order autonomy. No AI provider or budget is
assumed, and no secrets should be supplied through chat.