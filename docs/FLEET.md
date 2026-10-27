# Fleet — bounded paper automation

Multiple named bots propose and execute paper orders on the shared `paper-mainnet`
account. Every order flows through the same central executor, reservations, risk
limits and halts as manual orders. There is no alternate fill path, no venue
adapter and no live signing. This is the roadmap's "bounded paper promotion"
increment: it does not approve live trading, agents or strategy profitability.

## Execution authority

`FleetManager` (src/fleet.ts) evaluates each running bot once per second. A bot's
strategy returns a **direction proposal** (`open buy/sell`, `close fraction` or
`hold`); it never sizes orders and never sees the executor. The runner sizes the
order from the bot's own caps, journals the decision with its inputs and risk
checks, then submits a market IOC through `Paper.botOrder()` — which enforces every
existing account-level check: allocation %, per-order/per-gross notional caps,
initial margin and fees, baseline/funding/margin/recovery gates, emergency halt,
venue precision and minimums, fresh-metadata requirements and the single-flight
matcher. Rejections are journaled with the executor's error, never retried blind.

## Explicit gates

- **Automation authorization** is an operator action (`ENABLE PAPER AUTOMATION`
  confirmation) that enables order submission **for the current session only**.
  It is cleared on every server restart and audited both ways.
- Bots start **paused**; a restart never resumes a runner automatically.
- The emergency halt, daily-loss halts and all paper gates override automation.
- **Feed-health guard**: exposure-increasing proposals are refused unless the
  validated Lighter feed has been continuously healthy for the recovery dwell
  (default 60s) with a rolling healthy fraction above 99% (1h window). Counter
  regression or a recording failure latches integrity failure until restart.
  Reductions (closes) are never guard-blocked; the executor still requires
  fresh executable depth for them.

## Per-bot risk caps (in addition to account limits)

`maxNotionalPerOrder`, `maxOpenNotional` (the bot's own open fills minus
reductions), `maxOrdersPerHour`, `cooldownMs` between submissions, and
`maxDailyLossUsd` — a realized-loss stop that pauses the bot for the UTC day and
is journaled and audited. Leverage is clamped to the venue's market limit and 20×.

## Strategies

Strategies are deterministic direction proposals registered in an immutable
registry (`src/strategies/`). One file per strategy; `artifactHash` freezes
id/name/description/param-spec/evaluate source as the artifact identity recorded
in the journal. Built-ins: `breakout-v1` (1s-mid channel breakout),
`mean-reversion-v1` (z-score reversion), `funding-carry-v1` (funding-collecting
side; venue funding semantics remain unverified). Strategies see only validated
book/stats/public-trade context plus a 1s mid-price window maintained per bot.

## Decision journal

`decision_journal` (SQLite, bounded to 5,000 rows) records bot lifecycle events,
every actionable proposal, every submission and its outcome, guard transitions
and skips with reasons — each with the strategy id, inputs snapshot, risk-check
results and order id. Routine holds are not journaled. Read at
`GET /api/fleet/journal?botId=`. The journal is local evidence, not an
attestation: local administrators can alter the database.

## P&L attribution (read this before comparing bots)

Closed legs belong to **the bot that closed them**; fees belong to the fill's
bot. Manual, bot, protection and liquidation orders share one average position
per market, so **open P&L and funding are account-level and not attributable**.
Per-bot realized P&L, fees, closed-trade count and volume come from
`paperAnalytics().bots`. A manual close of a bot-opened position credits the
manual actor — disclosed here deliberately rather than faked.

## Replay backtest

`replayStrategy` (src/backtest-replay.ts) replays a recorded capture prefix
through any registered strategy with **no look-ahead**: a proposal evaluated on
one book update executes at the next update's top of book, with modeled fees
only (no depth walk, funding, halts or liquidation). Captures are bounded
prefixes; results are labeled in-sample evidence and save into the experiments
registry via the Backtest lab's existing promote flow. `POST /api/fleet/backtest`.

## Honest limitations

- Paper only: fills are simulated against public depth with a configured delay.
- Strategies are engineering defaults, not validated edges; the research
  engine's no-look-ahead discipline applies to replay, not to live edge.
- Feed-health criteria are engineering defaults, not approved risk policy.
- The 24-hour sustained acceptance gate remains open (the 2026-10-26 run failed
  on host disconnects/clock drift); automation here does not depend on it and
  live trading still does.
