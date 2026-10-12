# Local perpetual accounting increment

This is a **local paper model**, not exchange reconciliation or authorization for
autonomous trading. Live signing and agents remain disabled. Existing fill bytes,
session capital and liquidity-consumption evidence are not rewritten.

## Signed inventory and collateral

- Settlement v1 and fills without settlement retain their long-only replay semantics.
  New settlement v2 records `effect: open | reduce` and signed average-cost inventory.
- Buy opens/increases a long or reduces a short. Sell opens/increases a short or
  reduces a long. An order may not cross zero; close first and submit a separate
  opposite-side order. Automatic protections/liquidations may only reduce.
- Opening either side deducts `ceil(executed quote / leverage) + fees` from free
  cash. Short sale proceeds are **not** credited. Leverage never multiplies P&L.
- A reduction releases proportional reserved margin and realizes
  `sign(position) * (exit quote - allocated entry quote) - exit fees`.
  Entry fees and funding are allocated to closed legs; the final close consumes
  every residual unit. Account realized P&L charges entry fees at entry and funding
  at its economic hour, so closed-leg statistics must not be added again.
- Equity = free cash + reserved margin + signed mark-to-market P&L. Exposure and
  margin requirements use **absolute** position sizes. Missing valuation is unknown,
  not zero. Gap losses and funding can make cash/equity negative; reductions are
  not rejected merely because they crystallize a loss.
- Base quantities use 1e-8 atoms; money uses micro-USDC. Buys round quote up,
  sells down, fees up, signed marks/funding down. All risk checks remain integer-based.

## Funding evidence and deliberately delayed settlement

Official [funding docs](https://docs.lighter.xyz/trading/funding.md) say payments
occur at each hour mark and give `-position * index * fundingRate`. Positive rates
mean longs pay shorts; negative rates mean shorts pay longs. The public
[`fundings` API](https://apidocs.lighter.xyz/reference/fundings) returns `value`,
`rate`, `direction`, and second-based hourly timestamps in the saved evidence.
Direction identifies the paying side; `value` is treated as nonnegative USDC per
base unit. Payments use `value`, not rounded display rates or projected stream rates.

**Not proven:** the API documentation does not establish whether a history timestamp
labels the start/end of an accrual interval, exactly when records become final, or
how same-boundary positions are ordered against venue settlement. Saved
`scratch-live4.log`/`scratch-live5.log` are the same older sample, not a new sample;
records were unchanged over 75 seconds, which does not prove finality.

Explicit simulator policy:

1. Treat a history timestamp as its economic settlement hour; use durable holdings
   strictly **before** that timestamp. Funding precedes same-timestamp local fills.
2. Exclude current-hour history. Wait until timestamp + one hour before recording.
   This is a conservative finality delay, **not proof** of venue finality. Account
   equity can temporarily omit the latest hour's funding.
3. Persist source row, market identity, position snapshot, signed payment, recorded
   time and SHA-256 hash under a unique market/hour key. Replay validates snapshots,
   computed payments and hashes. Restart does not pay an hour twice.
4. Reconstruct historical holdings even when the position has since closed; missing
   required hours, duplicate rows, malformed values or identity problems block new
   exposure. No zero payment is invented for a missing record. Retry at most once
   per 30 seconds. Catch-up is bounded to 720 hours; older unresolved exposure
   requires offline review. Settled rows are immutable, not silently replaced.
5. A delayed debit does not invalidate a fill committed before that debit was known.
   Its cash effect is replayed and reported; future openings check actual free cash.
6. Funding is reconciled before production order preparation and during the monitor,
   including paused sessions. Old worker responses are fenced by restart generation.
   Test-only non-stream fixtures do not authorize production funding or liquidation.

This policy must be validated against exchange evidence before relying on the model
for strategy promotion. It does not claim verified settled venue funding.

## Cross-account margin and approximate liquidation

Official [liquidation docs](https://docs.lighter.xyz/trading/liquidations-and-llp-insurance-fund.md)
define initial, maintenance and closeout requirements as sums of
`abs(position) * mark * fraction`. Metadata fractions are interpreted in 1/10000
units. Selected initial requirements use at least both the user's leverage fraction
and the venue minimum. Maintenance/closeout use valid ordered venue metadata;
missing metadata falls back conservatively to selected initial margin and disables
automatic liquidation. Fresh marks are mandatory.

States: healthy (equity >= initial), reduce-only (below initial), liquidating (below
maintenance), closeout (below closeout), unknown (missing/stale marks). New exposure
is blocked outside healthy. Post-fill initial requirements are checked atomically.
Existing aggregate allocation, full-request reservations, notional caps, fee policy,
activation, loss/recovery halts, liquidity fences and freshness gates still apply.

The local liquidation monitor runs even when manual paper is paused/halted. With
verified metadata and fresh stream evidence, it cancels a pending opening and attempts
one full-position IOC per cycle, worst unrealized P&L first. It shares durable order
claims, matching latency, depth/precision/minimum constraints, liquidity consumption,
partial-fill handling and restart recovery with all other paper orders. No fresh
depth means **no fabricated fill**. Underfilled/rejected attempts leave exposure visible.

**Approximation:** the monitor does not reproduce Lighter's partial-liquidation zero
prices, heuristic ordering, fee cap against zero-price improvement, LLP takeover,
insurance fund capital or ADL. It charges a separately recorded, conservative 1%
of executed quote notional, rounded up, in addition to configured trading fees.
That surcharge is a simulation assumption, **not the venue fee formula**. Closeout
still uses visible depth, not a fake takeover at mark, and negative equity is not
forgiven. Isolated margin is not offered; one collateral pool backs all markets.

## Risk baselines and remaining gates

Daily realized P&L includes funding and liquidation fees. Prior-day funding is
included when constructing a flat opening baseline. If a later funding record changes
a prior-day amount after its baseline was locked, the baseline is never silently
rebased: baseline reconciliation latches a halt on new exposure. Overnight exact
UTC-boundary mark evidence remains unresolved. Transfers remain disabled; the
ledger's cash-flow helper is not a durable deposit/withdrawal API or provenance chain.

### Explicit manual baseline reconciliation

The manual workspace now shows a **Reconcile paper baseline** action when a baseline
halt is latched. `POST /api/paper/baseline-reconcile` requires the exact confirmation
`RECONCILE PAPER BASELINE` and the normal same-origin controls. It refreshes funding
reconciliation first and refuses pending matching work or a blocked funding state.
Only a delayed-funding halt with a checksummed **flat opening** and exact original
ledger provenance can be cleared. Pre-funding v1 hashes are recognized only by their
exact historical input shape with no original funding/transfers. Integrity conflicts,
legacy-unverified and overnight marks still require evidence repair; this is not RESET.

The original risk-day record and `paperBaselineMicros:<day>` remain byte-for-byte
unchanged. A separate checksummed reconciliation records corrected opening equity,
the baseline/funding hashes and an effective risk threshold equal to the maximum of
the original, corrected and any previous reconciled threshold. Delayed credits may
tighten the threshold; debits never lower it. Audit and halt-clear are atomic. Future
changed funding invalidates the reconciliation; emergency/loss/recovery halts are not
cleared, and enabling manual paper remains an explicit separate action.

See [funding evidence review](LIGHTER_FUNDING_EVIDENCE.md) for source claims versus
unproven simulator assumptions. Neither successful reconciliation nor a short public
sample certifies exchange-equivalent funding.

Required before automation: verify funding timestamp/position ordering and finality,
complete overnight baselines and transfer provenance, calibrate liquidation/fee
assumptions, record sustained mainnet operation and failure drills, and separately
approve strategy research/holdouts and bounded central autonomous paper authority.
Deterministic fixtures and browser tests cannot establish those exchange/runtime facts.

## Reproduce offline verification

From this project workspace, run `bun run scripts/verify-paper-accounting.ts`.
It runs TypeScript checking, the complete Bun unit suite, the production Vite build
and the desktop/mobile Edge Playwright fixtures, recording process exit codes in
`resume-verified-results.json` and output in `resume-verified-*-out.log`/`*-err.log`.
It does not request mainnet execution or turn on automated strategies.