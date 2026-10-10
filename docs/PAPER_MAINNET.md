# Revised direction: local paper trading from mainnet data

No venue signer, private key or testnet trading is needed for this direction.
Current state: an interim manual BTC, long-only, unleveraged local IOC simulator
uses mainnet REST depth. Matching and monetary reporting use integer units. It is
not perpetual accounting or validated continuous market data. Existing synthetic
production execution stays disabled. See ASSESSMENT.md for current limitations.

Repeated REST liquidity is not treated as replenished: simulated consumption is
persisted by market/side/price across refresh and restart. This intentionally can
underfill or reject orders until verified sequenced replenishment is implemented.
Unreferenced depth observations have a rolling 1,000-record limit; executed-order
evidence is retained. UTC loss checks run on observation and atomically on fill.

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