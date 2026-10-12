# Revised direction: local paper trading from mainnet data

No venue signer, private key or testnet trading is needed for this direction.
Current state: a multi-market, signed long/short, margin-backed local IOC simulator
uses validated mainnet WebSocket depth and market stats. Matching and monetary
reporting use integer units. History-derived funding and approximate liquidation are
implemented, but not certified venue-equivalent perpetual accounting. Existing synthetic
production execution stays disabled. See ASSESSMENT.md for current limitations.
Market/limit IOC and locally monitored position-level stops/targets are available;
see DATA_AND_EXECUTION.md for exact semantics and remaining work.
Sequenced order-book and market_stats ingestion are the sole paper authority; see
LIGHTER_STREAMING.md. Missing/stale depth or stats blocks fills, with no REST fallback.
Marks, not bid/mid/index/last trade, value positions and trigger local protection.
Browser updates use bounded SSE; reconnecting browsers cannot authorize new exposure.
Manual/protection IOC orders share durable budget/quantity reservations and atomic
terminal settlement. Restart fences old workers, reconciles local fill evidence and
blocks exposure on uncertainty. See [order lifecycle and recovery](PAPER_ORDER_LIFECYCLE.md).
Dedicated public trade recording and bounded snapshot-rooted replay prefixes add
[read-only evidence tooling](LIGHTER_EVIDENCE.md); coverage and cross-channel event
continuity remain unproven, with no change to matching or promotion authority.

Repeated public liquidity (even a new nonce) is not treated as replenished: consumption is
persisted by market/side/price across refresh and restart. This intentionally can
underfill or reject orders until verified sequenced replenishment is implemented.
Unreferenced depth observations have a rolling 1,000-record limit; executed-order
evidence is retained. UTC loss checks run on observation and atomically on fill.

## Bounded leverage model

Leverage defaults to 1× per market. `POST /api/paper/leverage` accepts whole numbers
up to `min(20, floor(10000 / min_initial_margin_fraction))`; missing/invalid venue
margin metadata allows only 1×. Changes are blocked during pending IOC matching or
while that market has an open position. The saved setting is used by the ticket.
Orders independently validate leverage, precision, minimums, activation, available
cash, shared allocation, gross exposure and per-order caps. Venue metadata is
refreshed at most once per minute; exposure increases require it within two minutes.

Entry deducts initial margin (quote/leverage, rounded up to a micro-dollar) plus fees.
Exit releases proportional margin and realizes the unscaled price P&L minus fees.
Equity is free cash + reserved margin + mark-to-market P&L, never gross asset value.
All position margins share one allocation budget; leverage does not multiply risk caps.
Legacy fills remain 1× and are not rewritten. Halted/paused reductions remain allowed
when fresh data is available. Gap losses may exceed margin and produce negative equity;
funding and liquidation also debit collateral. Shorts reserve collateral, never credit
sale proceeds. Reverse by closing first, then opening the opposite side. Funding
history is reconciled after a one-hour delay; liquidation is a depth-constrained IOC
approximation with a disclosed 1% notional surcharge, not venue LLP/ADL. No venue
submission occurs. See [exact policy and unresolved evidence](PAPER_PERPETUAL_ACCOUNTING.md).

## Data choice

For crypto perpetuals, use Lighter **mainnet** public trades, sequenced order-book
updates, mark/index prices and funding. Do not use testnet as a price benchmark.
Market metadata polling alone is not an order book and cannot justify simulated fills.
If “futures” means CME MES/ES instead, use a licensed CME real-time data provider;
crypto perpetual data is not a substitute for exchange-traded index futures.

Official fee reference: https://docs.lighter.xyz/perpetual-futures/fees
Retrieved during this change: Standard accounts have zero maker/taker fees, but
Plus and Premium accounts have fees. Standard taker and cancel/modify latency is
300 ms. Funding, spread, depth, latency and liquidation still affect perpetual P&L.
The simulator must pin and record its chosen fee tier rather than generalize zero fees.

## Required before local paper execution

- Validate the official public depth/trade/funding API and supported instruments.
- Sequenced snapshots/deltas, gap detection/resubscription, venue timestamps,
  heartbeat and freshness controls; stop matching on missing/stale/crossed books.
- Record immutable market observations, connection gaps and simulator configuration.
- Use integer price/size precision and venue minimums; explicit simulated capital.
- Market fills walk visible depth after modeled latency; reject or partially fill
  insufficient depth. Never fill at mark or assume unlimited liquidity.
- Limit fills require conservative queue/trade evidence; touching a quote is not a fill.
- Persistent orders, partial fills, cancellation latency, stable IDs and restart recovery.
- Net P&L includes realized/unrealized P&L, fees and signed funding; mark/index are
  for valuation/risk, not executable prices. Model margin and liquidation conservatively.
- Wire all simulated orders through the shared risk authority; account for pending
  reservations and prohibit agents bypassing it. Reconcile positions/cash on restart.
- Separate local paper balance from public venue account equity and old synthetic history.

## Step 5 agents: inputs and evidence needed

User decisions: crypto perpetuals vs CME futures; symbols; starting paper capital;
account fee tier; leverage/allocation/daily-loss limits; strategy timeframes and
allowed order types; intended agent/model provider and spending budget.

Engineering: the validated data/matching/accounting stack above; browser acceptance;
durable observation and intent queues; isolated agent workers without keys; bounded
timeouts/token budgets; typed intents with source timestamps; versioned strategies;
central atomic risk/kill authority; monitoring and tested restart/disconnect drills.

Research: provenance-verified historical trades/candles/funding, calibrated execution
assumptions, frozen holdout/walk-forward results against baselines, and sustained
forward paper evidence with predeclared promotion criteria. Agent coordination must
not multiply allocation or silently change strategies after inspecting holdout results.

Signer authentication and venue testnet order exercises are removed from the local
paper scope. They become separate gates only if real venue execution is requested later.