# Paper order lifecycle and recovery

This is a **local-paper** lifecycle, not venue reconciliation or agent authorization.
Manual entries/exits and local protection exits use `Paper.submit` and `PaperOrders`.
The separate `ExecutionRisk` contract remains disconnected from any venue adapter.
No agents, signer, shorts, resting GTC orders, funding settlement or liquidation are added.

## Admission and settlement

1. A stable order ID claims the single-flight matcher in SQLite. The canonical
   intent records market, side, size, type/limit, requested leverage and trusted
   source. Identical retries return pending/terminal evidence without resubmission;
   changed economic intent or source under the same ID is rejected. HTTP callers
   cannot set internal source, generation, protection reason or lifecycle fields.
2. Fresh authoritative depth/marks and venue metadata establish a durable reservation
   **before modeled latency**. A buy holds the entire requested notional at the
   initial best ask plus the 50bps collar, capped by its limit. Price-tick rounding
   is upward; quote, initial margin and fee holds round up to micro-dollars.
   This is conservative: a large request may be rejected even if depth would only
   partially fill it. Sells reserve held quantity only and cannot open shorts.
3. Allocation, free cash, per-order/account caps, activation, loss/kill latches,
   metadata and prior unresolved reservations remain backend checks. The matcher
   remains single-flight; a second order cannot borrow or reuse pending budget.
4. After latency, authoritative freshness and risk are checked again. Fills cannot
   exceed their reserved notional or margin/fee budget. A price gap above the hold
   rejects the IOC; the operator must use a new ID, not silently expand the budget.
5. Depth consumption, integer fill settlement, loss latch, full-close protection
   removal, terminal order evidence and reservation deletion commit in one SQLite
   transaction. Partial fill charges only the actual fill; all unused hold is
   released. Rejection and nonmarketable-limit cancellation also release atomically.

Reservations are **encumbrances**, not ledger cash deductions. Pending budget is
shown separately and subtracted from ticket buying power; fills alone change cash.
The pending order retains its original reservation for diagnostics after release.

## Local cancellation

`POST /api/paper/cancel` with `{ "id": "stable-order-id" }` cancels a pending local
IOC before settlement. It is same-origin JSON only and idempotent. The UI exposes
“Cancel pending IOC” while the order is pending. SQLite serialization decides the
race: cancellation first means no fill; settlement first returns the already-terminal
result. Cancellation cannot undo a committed fill. This is immediate local simulator
cancellation, **not** a venue cancel acknowledgement or Lighter cancel-latency model.

## Restart and uncertainty

- Every `Paper` startup pauses activation/protection monitoring and issues a new
  durable generation. Suspended old workers cannot reserve, settle, or overwrite
  terminal evidence after restart, even if the operator re-enables the new worker.
- Recovery scans all orders, fills and reservations, not the 100-row display limit,
  and replays the integer balance. Committed terminal fills are preserved.
- A pending IOC **without a committed local fill** is rejected as interrupted,
  releases its hold, and is never replayed. This is justified only because this
  simulator has no remote execution and local fill settlement is atomic.
- Missing/conflicting fill or execution evidence, pending+fill contradictions and
  orphan reservations are not guessed away. Recovery reports issues and blocks new
  exposure. General emergency RESET does not clear this recovery block.
- Where ledger evidence is valid and no unresolved pending order owns the matcher,
  fresh-data reducing exits remain allowed while recovery-blocked, paused or halted.
  An ambiguous pending order blocks all matching rather than risking a duplicate exit.
- Preserve the database/WAL and audit, inspect the reported issue, and restore verified
  evidence from a stopped backup if needed. There is deliberately no HTTP “trust me”
  recovery override. Restart rechecks repaired evidence; do not erase reservations
  merely because time passed.

`GET /api/paper/session` and SSE include `orderManagement`: generation, recovery
report, exposure block, pending state, reservations and integer reserved totals.

## Protection and future agents

Stops/targets submit through the same reservation/settlement path. Trigger latches
survive partial/rejected exits and rebounds; each new attempt uses a fresh ID and
the ledger's remaining position size. Restart pauses monitoring; downtime remains
unprotected. One-second throttling, fresh-data requirements and conservative liquidity
consumption still apply.

Future agents must propose typed, expiring, strategy-versioned intents to this
authority through a separately approved adapter. They must not write orders,
reservations, fills, policies or reconciliation state directly. Shadow proposals,
then human approval, then bounded paper autonomy remain separate promotion gates.
This change does not resolve UTC midnight-baseline, replay/trade-evidence, funding,
liquidation, complete accounting or sustained forward-validation gaps.

## Validation

`bun test` covers pending/terminal duplicates, conservative holds, partial-fill
release, cancellation races, disconnects, price gaps, policy/kill changes during
latency, restart fencing, disk reopen, contradictory/orphan recovery state, halted
reductions and latched stop retries. Existing stream tests cover stale authoritative
data after modeled latency. Run `bun run scripts/verify-paper-orders.ts` for captured
TypeScript, test, production-build, browser, smoke and whitespace results.