# Historical backfill — the screen lane (docs)

Long public market history answers the question our own recordings cannot yet:
**does a strategy family have any edge at all?** The data engine accumulates
Lighter recordings day by day; historical backfill gives the research lane years
of 1-second candles today.

## The two-tier honesty rule (read this first)

1. **Screen on history.** Public klines (default: Binance spot 1s candles, no API
   key, no account) feed a replay with the same no-look-ahead contract as the
   Lighter replay — a proposal evaluated on candle *i* executes at candle
   *i+1*'s open. Candidates must survive the same multiplicity-corrected
   SPA/StepM verifier used for promotions.
2. **Prove on Lighter.** Only a PASS verdict from a **Lighter capture**
   (`scripts/research-promote.ts`) can ever install `research/promotions.json`
   and make a config registerable. The walk-forward script hard-codes
   `canPromote: false` — historical data can screen, never promote.

Why: the history is a different venue (fees, spreads, liquidity, funding
cadence), replayed with an honestly weaker market model (synthetic two-quote
book at each close, next-open fills, no depth walk, funding as a signal only).
An edge found here is a strong clue, not proof for Lighter.

## Downloading history

```
bun run scripts/download-history.ts --symbol BTCUSDT --days 30 --funding
```

- Source: Binance spot klines via `data-api.binance.vision` (official public
  market-data mirror; no key, no auth). `--interval 1m` is also supported.
- Storage: `data/history/binance-spot-<SYMBOL>-<INTERVAL>/<UTC-day>.jsonl` +
  `meta.json` (+ `funding.jsonl` when `--funding` succeeds). Runtime data,
  git-ignored; back it up to the operator's Drive like the capture archive.
- Resumable: re-running skips days already on disk. Polite: sequential requests,
  ~150ms spacing, retry with backoff. Expect roughly 90 requests and ~4 MB per
  symbol-day at 1s resolution (a 30-day BTCUSDT pull takes a few minutes).
- Funding comes from the futures API and may be geo-blocked; the download then
  succeeds WITHOUT funding and records why — funding-carry simply sees no
  signal in that case (and Binance funding is 8-hourly, not Lighter's hourly:
  treat funding-carry historical results as indicative only).

## Running the walk-forward screen

```
bun run scripts/research-walkforward.ts --history data/history/binance-spot-BTCUSDT-1s \
  --market BTC --train-days 20 --holdout-days 5
```

- The LAST `--holdout-days` of history are untouched; the `--train-days` before
  them train. All candidates (default: the three built-ins; `--configs` accepts
  a JSON array) replay on both windows.
- Train equity is sampled every `--equity-step` candles (default 300 = 5
  minutes at 1s) and screened by `research/spa_verify.py` (needs the research
  venv). Survivors must then beat cash net of fees on the holdout.
- Output: a report JSON under `research/verdicts/<ts>-walkforward.json` plus a
  console summary. Exit code 0 only if something is verified.
- Nothing here touches the promotion manifest or the fleet.

## Honest limitations (also embedded in every result's warnings)

- Different venue than Lighter; results are clues, not venue proof.
- Synthetic book at each close; next-open fills; no depth walk, no queue, no
  partial liquidity, no funding cash flows, no halts or liquidation modeling.
- 1s klines can have gaps on quiet markets; day counts in the split are
  approximations when gaps exist.
- Curve-fitting remains the enemy: the SPA screen and the untouched holdout are
  the defenses — never weaken either to force a pass.
