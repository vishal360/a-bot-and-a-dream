# Implementation assessment and completion inputs

## Current assessment

Live read-only feed check on 2026-10-09 succeeded: BTC market 1, perpetual metadata,
5 size decimals, minimum base 0.00007 BTC and minimum quote $10. The observation
reported bid 82456.4 / ask 82459.3. This was a connectivity check, not a paper or venue
order, and is not a promise that later observations will remain available.

Overall: 5/10 as a trading-system prototype, not production approval. The control plane,
research ledger, credential vault and safety boundaries are useful. Automated trading,
continuous validated depth and complete perpetual accounting are not complete.

## Available now: interim manual simulation

Command center and Executions expose a separate `paper-mainnet` account with $10,000
simulated starting cash. Set allocation above 0% in Portfolio & risk, enable manual
paper, then submit a small BTC buy IOC (default 0.001 BTC, subject to live minimums).
Orders and observations persist in SQLite. Buys consume asks; reducing sells consume
bids. Visible depth within a 50 bps collar is used, remainder canceled. No mark-price
fills or synthetic-feed fallback. Reduce-only selling is permitted while halted/paused.

This is a long-only, cash-collateralized BTC price simulation against public Lighter
data. It is NOT spot venue execution or a complete Lighter perpetual account.
Assumptions: 2 bps per side and 300 ms configured delay (plus request duration), not
verified venue terms. No funding, shorts, liquidation, resting limits, stops, sequenced
WebSocket recovery or agents. REST receipt freshness is not proof of exchange-event
freshness. Snapshot liquidity can reappear on later requests; queue/market-impact
modeling remains incomplete. Manual-account monetary reports now use the integer ledger;
imported and legacy synthetic-account analytics retain their original reporting engine.

The account reopens paused. In-flight IOCs become rejected after restart; never replayed.
The loss latch persists and has no user reset. The baseline is first observed equity
of each UTC day, not verified midnight equity. A complete midnight/cash-flow baseline
and central reservation lifecycle remain prerequisites for agents.

Legacy synthetic paper routes stay disabled. Imported marks/fills cannot overwrite
the mainnet simulation. Stats reset is blocked after mainnet simulation fills to
prevent destroying cash/baseline continuity; separate session archival is pending.
Raw depth retention keeps the latest 1,000 observations plus observations referenced
by executed orders. Fill evidence is never discarded merely to meet the rolling limit.

## Priority backlog

Integer accounting increment: paper-mainnet now replays versioned fill settlements
using BTC atoms (1e-8 BTC) and quote micro-dollars. Cash, inventory, remaining cost
basis, aggregate/daily realized P&L and mark valuation use BigInt arithmetic.
Buy authorization uses the replayed cash balance and integer notional/allocation
comparisons; oversells no longer use a floating tolerance. Each new fill stores
exact settlement strings atomically with its order. Legacy fill payloads are not
rewritten: replay rounds their historical quote/fee to the nearest micro-dollar
and exposes a legacyFills count. Partial closes retain remainder cost basis until
the final close, so no micro-dollars disappear. Invalid settlement, oversell and
negative-cash history fail closed. Generic trade statistics, curves and per-bot
analytics for this account now share `paperAnalytics` across the manual account and
Operations views. Trade fee allocation, realized curves, per-bot contributions,
daily P&L and cash/equity reconcile to the same ledger. Ratios and display conversions
remain numbers; monetary accumulation is integer. Imported-account analytics are
not treated as exact paper settlements.

The internal execution-risk contract now commits verified terminal evidence and a
fresh matching-generation reconciliation atomically before releasing a reservation.
Terminal IDs cannot be reserved again; conflicting evidence and failed reconciliation
retain the reservation. There is still no venue adapter or HTTP terminal-release route.
Per-generation reconciliation watermarks persist across restart and invalidation;
clearing executable equity no longer permits replay of an older risk snapshot.
Manual IOC admission uses a database-level pending claim in addition to the local
busy guard. The existing first-observation UTC baseline remains the policy, now
persisted and compared in integer micro-dollars; it is not a verified midnight baseline.

REST depth consumption is persisted by market/side/price, including a one-time
migration of previously recorded execution legs. Repeated snapshots and restarts
cannot silently replenish consumed liquidity. This is deliberately conservative:
price-level replenishment cannot be proved without sequenced queue data. Old fills
missing observation/leg evidence block further exposure increases, not reductions.
Duplicate price levels are aggregated exactly before matching; venue precision is
validated before publishing the snapshot. Overlapping observations are rejected.

Verification is recorded in `validation.log` and `resume-browser.log`, with explicit
exit markers rather than inferred from empty terminal output. These tests verify the
interim manual model, not perpetual economics or readiness for autonomous/live trading.
Latest verified run: 48 unit/integration tests, both desktop/mobile-sized Edge workflows,
TypeScript, production build/static-asset HTTP smoke and tracked whitespace checks pass.
SQLite uses FULL synchronous durability and a bounded lock wait. Risk-policy saves
reject unsupported micro-dollar precision and unknown fields. Loss thresholds also
run within the fill transaction, so fees cannot defer a loss latch until the next poll.

Step 2 increment: IOC matching now uses integer venue-size/price units with a
strict integer price collar. Settlement and fees are recorded as micro-dollar
strings, with conservative rounding, alongside the executed depth legs. Order
and allocation checks include actual depth cost rather than just the best quote.
Restart recovery scans all pending orders (not only the latest 100). Browser
cleanup waits for server termination before deleting its temporary database.
The subsequent ledger/report migration above supersedes this increment's original
floating-point accounting limitations. Sequenced liquidity, a connected shared
reservation authority and perpetual accounting remain open.

Step 1 progress: automated desktop Edge and mobile-sized Edge workflow acceptance
passed on 2026-10-09. Both exercised allocation rejection, explicit activation,
depth-priced partial fill, independent P&L assertions, refresh persistence,
server restart with paused recovery, and closing while halted. No browser runtime
errors or document-level horizontal overflow were detected in those workflows.
Physical-device/Safari testing and wider visual acceptance remain outstanding.

1. Confirm live metadata/data availability and desktop/mobile browser acceptance.
2. Replace REST-only observations with sequenced depth/trades, gap recovery, freshness
   and durable bounded recording; use metadata for integer price/quantity economics.
3. Build complete perpetual accounting (funding, margin, liquidation, shorts), durable
   order state and conservative queue/limit/stop/cancellation models.
4. Unify execution-risk reconciliation, terminal-state reservation release, immutable
   midnight baselines and cash flows. The interim matcher checks shared allocation,
   halts and unresolved reservations but is not the full reservation-backed authority.
5. Complete session lifecycle and retention, failure drills, replay/holdout/walk-forward
   evidence and sustained paper-forward testing.
6. Implement isolated agents that propose typed intents only; one central executor
   owns risk, queues, idempotency and order writes. Add budgets, monitoring and drills.

## Inputs to provide

- Instrument scope: BTC/ETH crypto perpetuals, spot-style research, or MES/ES futures.
  CME futures need an appropriate licensed feed; crypto prices cannot stand in for MES.
- Symbols, timeframes, trading hours and holding horizon.
- Simulated capital/currency, account/session reset behavior and fee-tier assumptions.
- Risk: allocation, total/per-symbol exposure, target leverage, daily loss, per-trade
  risk, max positions, drawdown and flatten/kill policy.
- Order types: IOC/market, resting limits, stops, take-profits, reduce-only and collars.
- Strategies: exact entry/exit/sizing rules, or permission to propose research candidates.
- Historical data source/access and desired holdout/forward-test acceptance criteria.
- Agent count/roles, model/provider, monthly and daily token/cost budget, decision cadence,
  allowed tools, approval requirements and behavior when models/data are unavailable.
- Deployment: local-only or hosted, uptime, alerts destination, backups and data retention.

Do not paste private keys or API secrets into chat. Local public-data paper trading
requires no Lighter signer/key or funded venue account. Provider keys for future agents
should be configured securely on the machine, not shared in conversation.