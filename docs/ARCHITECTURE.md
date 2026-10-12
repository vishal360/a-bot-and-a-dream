# Architecture

## Perpetual paper accounting authority

`paper-ledger.ts` replays immutable legacy fills and signed settlement-v2 fills in
integer units. `paper-funding.ts` persists hash-checked, delayed hourly history
events; `paper-margin.ts` evaluates cross-account thresholds against fresh marks.
`Paper` integrates these with existing durable IOC claims, reservations, matching,
protection/restart handling and the account view. No venue transactions or agent
authority are added. See [accounting policies and unresolved evidence](PAPER_PERPETUAL_ACCOUNTING.md).

## Current implementation

Browser React application → same-origin Bun HTTP API → SQLite state/audit/registry.

`src/domain.ts`: validated deterministic research functions and shared types.
`src/store.ts`: transactions, bot state, persistent halt, runs and immutable registration.
`src/server.ts`: loopback API, origin/host boundaries, static build serving and safe restart.
`src/web/`: terminal UI; backend remains authoritative for actions and risk constraints.
`src/paper.ts` and `src/paper-orders.ts`: single-flight local-paper IOC executor,
durable budget/quantity reservations, atomic settlement/release, intent deduplication,
generation fencing and restart evidence checks. Manual and protection exits share
this authority; no agent or venue adapter is enabled. See [paper lifecycle](PAPER_ORDER_LIFECYCLE.md).
`src/lighter-trades.ts` and `src/lighter-evidence.ts`: validated read-only public
trade records and bounded connection-prefix captures. Pure replay reconstructs
books/stats/trades without an executor or ledger; see [evidence limits](LIGHTER_EVIDENCE.md).

`src/paper-risk-days.ts` records immutable baseline provenance for the fixed-capital
local ledger; conflicting evidence latches new exposure off. `src/lighter-acceptance.ts`
and `scripts/accept-lighter.ts` aggregate bounded read-only runtime/replay evidence in
an isolated database, never the operator account. See [remaining automation gates](AUTOMATION_ROADMAP.md).

SQLite is appropriate for this single-user local control plane, not the final multi-host ledger. Runs are JSON evidence snapshots. Hashes identify evidence; they are not signatures or tamper-proof attestations. Registry insertion is idempotent by run ID. UI polls state every three seconds; displayed sync time is a control-plane response time, not a market heartbeat.

## Target execution protocol

Add an isolated Python/NautilusTrader service only after broker and venue selection. Strategy emits OrderIntent containing stable ID, bot/version/account/instrument, side, quantity, order type, price constraints, expiry and source data timestamps. Account risk authority reserves aggregate exposure before forwarding. Execution publishes acknowledgments, fills, rejection/unknown states and reconciliation results. Use decimal/integer tick money representation at the execution boundary; JavaScript floating-point research arithmetic is not a financial ledger.

The execution service owns broker credentials; browser and research agents never receive them. Durable command deduplication and reconciliation, not delivery claims, establish effective execution state. The risk service must remain authoritative if UI, database projections or research fail.

## Adding bots

Current profiles are seeded once in Store; existing databases are not silently migrated by editing the seed. A future plugin includes identity/capabilities, immutable strategy artifact, accepted instrument schema, bounded risk policy, observation interface, signal generation and lifecycle hooks. New asset adapters must declare precision, fees, calendars, market data semantics and reconciliation capabilities. Do not add a bot by giving arbitrary code broker access.

## Dependency decisions

React/TypeScript for terminal; Bun for local API/testing/SQLite; Vite for frontend build. Later evaluate pinned NautilusTrader, skfolio for multi-strategy allocations, OpenBB for enrichment and research-only model/agent services. No repository popularity or model forecast substitutes for measured edge.