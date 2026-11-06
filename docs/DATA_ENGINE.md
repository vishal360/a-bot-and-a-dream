# Data engine — durable market-data archive

Before 2026-10-28 the live feed recorded bounded captures into a **4-slot evidence
ring** (2,000 frames / 8 MiB each). Two consequences: a capture that hit capacity
ended recording until the next reconnect, and everything older than four captures
was evicted **forever**. The data engine removes both problems.

## What it does

1. **Rolling captures** (src/lighter-stream.ts): when a capture hits capacity the
   stream immediately begins a successor (`<epoch>-r<N>`) inside the same
   connection and keeps appending — recording no longer stops mid-connection.
   The stream epoch remains the connection identity; diagnostics are unchanged.
2. **Continuous export** (src/data-engine.ts): a low-frequency engine (10s poll)
   exports every terminal capture — `closed`, `limited` and `interrupted`
   (restart orphans included) — to durable storage **before** the evidence ring
   can evict it.

## Layout

```
data/archive/<UTC-day>/<startedMs>-<captureId>.json   one self-contained ReplayCapture
data/archive/index.jsonl                              one JSON line per archived capture
```

Each file is the exact `ReplayCapture` JSON that `replayStrategy`,
`scripts/replay-lighter.ts` and `scripts/research-promote.ts` already consume —
no conversion step. The index records captureId, file, sha256, markets, time
range, state, frames, source bytes, archive bytes and archivedAt.

## Integrity

- The engine recomputes the capture checksum before writing and refuses to store
  a capture that fails its own round-trip check; failures are audited
  (`DATA_ARCHIVE_FAILURE`) and visible at `GET /api/archive`.
- The archive vouches for **bytes recorded**, not for edge content: semantic
  validation (frame order, book replay, manifest rules) happens at replay time in
  `replayCapture`, and the research gate re-validates everything again.
- Writes are atomic (tmp file + rename); the index is rewritten atomically.

## Retention

- `keepDays` (default 30) — captures older than this are deleted, oldest first.
- `keepBytes` (default 2 GiB) — when the archive exceeds this, oldest captures
  are pruned until it fits. Files and index lines are removed together.
- `data/archive/` is covered by the existing `data/*` gitignore rule — archives
  are runtime data, never committed.

## Operating it

- Status: `GET /api/archive` (ring contents, archive count, bytes on disk,
  retention limits, last failures).
- Research: `bun run scripts/research-promote.ts --capture data/archive/<day>/<file>.json --market BTC`
  replays candidates over any archived capture; walk-forward corpora are just
  lists of these files.
- Configuration lives in `src/server.ts` where the engine is constructed
  (`keepDays`, `keepBytes`, `root`). No keys, no credentials, no signing: the
  engine only writes public market data this machine already received.

## Health watchdog and database backups (2026-11-02)

- `src/health.ts` (HealthMonitor) checks every 60s: disk free floor under the
  archive, capture stall while the feed streams, Drive mirror staleness (last
  `mirror cycle done` in mirror.log), and DB backup failures. Alerts journal as
  `health-alert` (the Telegram alerter pushes them) with a 6h per-check
  cooldown; a check that cannot run reports `unavailable` and never false-alarms.
- `src/backup.ts` (DbBackup) snapshots `terminal.sqlite` every 6h via
  `VACUUM INTO` from a read-only connection into `data/backups/db` plus a
  REQUIRED copy to the Drive `db-backups` folder (an unmountable Drive is a loud
  health-alert, never silent local-only), keeping the newest 7 in both places.
  Quiet success (audit line), loud failure (journal + alert).
- Both are visible on `GET /api/health` under `vault` and `backup`.
- `scripts/verify-funding-semantics.ts` reads the archived market_stats frames
  (funding_rate + funding_timestamp) and reports the venue's ACTUAL funding
  cadence per market to `research/funding-semantics.json` - timestamp-derived
  cadences are authoritative; rate-change-derived ones are marked as inference.
  First run on real captures: BTC funding cadence ~1h (authoritative).

## Own-capture walk-forward grading (2026-11-02)

- `scripts/research-own-captures.ts` grades the builtin strategy set over OUR OWN
  recordings - the local vault AND the Drive mirror (completed days are moved
  hourly, so a whole-day corpus lives on Drive; days present in both are read
  from local only). Quote-derived bars: the venue's own market_stats mid_price,
  falling back to the top-of-book midpoint; volume is 0 BY CONSTRUCTION (book
  snapshots say nothing about traded volume - volume-aware strategies are
  meaningless here and the report says so).
- Two-tier honesty as everywhere: SPA screen on the train window, untouched
  holdout after; INSUFFICIENT is a first-class report (small corpora are a
  "keep recording" verdict, never a shrug); a PASS here is real venue evidence
  but still never installs research/promotions.json - promotion stays with
  scripts/research-promote.ts alone.
- First real run: 6 day folders (5 from the Drive mirror), ~385 one-minute bars,
  ~378k mid samples -> honestly INSUFFICIENT until a few full days accumulate.
- 2026-11-07 cross-root fixes found by real data: capture files are now read from
  the root their day folder was found in (Drive days were silently ENOENTd by the
  local-only read path), cloud-filter listings are enumerated until stable, and
  the grader gained `--from/--to` day windows plus `--train-bars` (bars-mode
  split via `splitByBars` for gappy corpora where day-counts assume contiguous
  coverage). First REAL verdict on the full corpus: 3614 Drive captures ->
  3308 one-minute bars, 2.75M mid samples, 5 contiguous days -> SPA screen FAIL,
  all three builtins train-eliminated. Verdict archived in research/verdicts.

## Backup scheduling and Drive retention (2026-11-07)

- The first DB snapshot now runs ~5 minutes after boot (was: a full 6h interval
  later - a crash in the first hours lost the day's evidence), and a watchdog
  raises one health-alert if the process has been up 12h with zero successful
  backups. `GET /api/health` -> backup status exposes the new fields.
- `scripts/prune-drive-archive.ps1` enforces the operator's 6-month Drive
  retention policy: DRY-RUN BY DEFAULT, `-Apply` deletes day folders older than
  the cutoff (pure YYYY-MM-DD folders only), one summary line per deletion into
  prune.log (the watchdog's mirror parser is unaffected).
