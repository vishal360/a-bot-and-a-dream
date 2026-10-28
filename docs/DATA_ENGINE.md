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
