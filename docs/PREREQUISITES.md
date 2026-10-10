# Steps 2–4 acceptance gates

**Scope changed:** local mainnet-data paper execution replaces venue testnet execution.
See [revised paper plan](PAPER_MAINNET.md), which supersedes signer/testnet gates below
for this local paper scope. Signing is required only for any future real execution.

Status: **incomplete; step 5 agents and all venue execution remain disabled**.
`GET /api/readiness` reports outstanding gates; no override or promotion switch exists.

## Step 2 — operational foundation

Implemented: public venue reads, encrypted local key storage, redacted archive/reset,
journal, persistent aggregate allocation and fail-closed public equity preview.
Required evidence: browser refresh/staleness/persistence and navigation tests;
archive/download/open-position rejection and connection security review;
pinned official signer and supported local runtime; rotated key entered locally;
authentication-only verification. Public account existence is not authentication.

## Step 3 — execution and risk

Implemented foundation: `ExecutionRisk` stores durable reservations in SQLite and
uses immediate transactions to serialize budget checks. Safe integer quote-currency
micro-units and BigInt comparisons avoid floating-point money arithmetic. It checks
aggregate used plus pending margin against current equity × allocation, individual
and aggregate 20x leverage ceilings, matching connection generation, current UTC day,
30-second freshness and persistent emergency/daily-loss halts. The 6% loss test uses
start equity + cumulative net cash flow − current equity. Fees, funding and unrealized
P&L must already be included in reconciled equity. This threshold cannot cap losses.
The opening baseline is persisted and immutable for each connection generation/UTC
day; conflicting or older snapshots are rejected while a current snapshot exists.
Connection rotation and restart still require an adapter with durable sequence and
baseline provenance; a caller-supplied generation is not authentication.

**Not venue-connected.** Only an internal adapter may supply reconciliation; there
is no HTTP snapshot/reservation mutation endpoint. Snapshots invalidate on restart
and connection save/delete; unresolved reservations survive. A duplicate reservation
is deduplication, not authorization to submit again. Reservations never expire on a
timeout; there is intentionally no release or loss-halt-reset API yet. Ordinary
terminal RESET and statistics reset do not clear the independent execution loss latch.

Still required: trusted UTC opening-equity and cash-flow provenance, currency/precision
mapping, per-market minimums, actual margin model, serialized nonce/client IDs,
durable order lifecycle, cancel/fill races, funding and manual-order reconciliation,
atomic terminal-state reservation release, restart recovery and failure drills.
Generation checks must also surround every asynchronous adapter result. Explicit
authorization is required before even a tiny testnet order; mainnet remains read-only.

## Step 4 — strategy validation

Required: selected instruments/timeframes, approved risk limits, provenance-verified
historical OHLC/funding with quality checks, realistic fees/slippage/liquidity,
frozen holdouts, walk-forward comparisons and sustained authenticated testnet forward
evidence. Synthetic or unverified uploaded backtests cannot satisfy this gate.

## Step 5 boundary

Future agents propose intents only. One shared execution/risk service owns keys and
aggregate limits. Agents may not bypass reservations, reset halts, change strategy
artifacts silently or claim readiness from a passing software build.