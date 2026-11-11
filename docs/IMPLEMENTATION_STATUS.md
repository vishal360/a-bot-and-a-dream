# External-review implementation status — 2026-11-11

## Scope and authority

Audited GitHub snapshot 58e08c8 against the external profitability roadmap. Work is in a separate workspace clone, not the operator's original Cline checkout or running terminal. No credentials copied, no venue orders submitted, no production state changed, no automatic authorization enabled. No commit or push yet. This status supersedes historical contradictory completion/promotion claims in older docs.

## What the previous AI actually shipped

Commits c2ca49a and 3aeab47 added arrival-delay/depth replay, diagnostic continuous funding accrual, v2 promotion metadata, calibration wording, JSONL journal spillway, lifetime agent counters and fleet equity brake. Commit 58e08c8 saved resumption helpers and minor tests/scripts. These were real source changes, not just inventory edits, but several were incomplete or unsafe in edge cases.

Baseline verification on a clean clone: typecheck passed; unit/integration suite had 355 pass / 13 fail (368 tests). Twelve failures came from agent fixtures implicitly requiring the operator's real Gemini environment; one promotion expiry assertion expected a different validation reason. No secrets were imported to make these tests pass.

## Implemented in this continuation

### Replay causality/accounting

- Immutable pending order holds decision quote, quantity and monotonic arrival; fast frames or a later hold cannot overwrite an in-flight order.
- Price guard anchored to decision quote; fills not eligible in the decision event.
- Signed short positions in strategy context; short sizing uses bid.
- Partial closes conserve proportional basis and allocate entry fees once.
- Explicit depth consumption/replenishment assumptions, partials and meaningful rejects.
- Strict execution-depth and price-guard validation.
- No invented end-of-capture liquidation. Residual equity is explicitly midpoint-marked, without fictional exit liquidity or future exit fees.
- Later stats cash events append observations rather than rewriting earlier equity. Faults cancel pre-fault pending orders.
- Simulator version is now replay-v4-explicit-hourly-funding; older identities cannot silently certify changed simulations.
- Continuous funding cash accrual was subsequently removed: explicit validated hourly history settles before same-time fills using exact atoms/micros, with coverage/ledger/allocation tests. Complete local model coverage does NOT prove venue settlement semantics. Funding-dependent candidates remain ineligible pending independent venue corroboration.
- The next requested stages (four research-only strategies, durable backups/alerts, locked execution foundations) are tracked in docs/NEXT_STAGES.md; that document supersedes this audit's earlier remaining-work list.

### Historical candle screen

- Applied signed short context, proportional residual basis and entry-fee attribution fixes to both taker and maker branches.
- Final modeled close is reflected in final equity/drawdown; candle terminal close remains an explicit weak screening assumption, unlike capture replay residual marking.
- All taker exits pay adverse opposite-side half-spread, including maker-expiry fallback and terminal liquidation; actual maker-limit fills retain limit prices.
- Validates OHLC envelopes, execution model, safe close timestamps and overlapping candles.
- Day-count splits verify every timestamp's cadence rather than extrapolate from the first pair; bars mode requires strictly chronological input.
- Explicit close-to-next-open gaps cancel pending orders and reset feature warmup. Existing exposure remains visible; no gap fills invented. This does not establish complete quality of quote-derived bars or independent samples.

### Promotion honesty

- Single-capture SPA script no longer installs/overwrites promotions.json, even on PASS. It archives a screen-only artifact and exits nonzero because requested promotion is denied.
- Explicit paperOnly=true, researchApproved=false, independentHoldout=false. No fabricated holdout JSON field can convert a screen to genuine approval.
- Existing manifests remain paper configuration allowlists only; missing manifest preserves explicitly unverified paper experimentation. Nothing authorizes live trading.
- v2 requires finite capital envelope, exact current simulator, coherent nonfuture timestamps; expiry is checked during use, not just at startup. Owned validated snapshots prevent later caller mutation.
- Hashes remain local integrity checks, not signatures or proof of independent evidence.

### Fleet risk

- Equity brake denies opens but permits verified strategy reductions from running, session-authorized bots.
- Promotion revocation and realized daily-loss limit no longer strand reductions. Flat daily-loss bots pause.
- Invalid positions/close fractions cannot dereference or submit.
- Exactly one submission per tick prevents sibling closes using one stale position snapshot.
- UTC-day loss trip persisted through equity recovery/restart; invalid/nonpositive equity fails closed while enabled.
- Existing explicit pct=0 disable remains available and audited; reenabling the same day restores the latch. Baseline is still first enabled-fleet tick, not reconstructed historical midnight equity.
- No auto-resume, no forced liquidation, no native exchange protection added. This is paper fleet safety only.

### Durable decisions

- Every decision is copied atomically into append-only SQLite decision_history in the same transaction as the bounded UI journal.
- Existing retained ring rows migrate on startup. Already-lost old decisions cannot be reconstructed by this change.
- JSONL spill is secondary; its failure no longer deletes authoritative evidence. historySinceId supports paginated durable access; archive status reports history rows and storage role.
- History insertion failure rolls back ring insert/pruning. Offsite backup/upload verification and retention still need work. SQLite history grows and needs measured capacity management; do not prune it without verified export/recovery policy.

### Agent evidence

- Legacy byDay counters migrate without replacing larger known history with a smaller recent journal seed.
- Missing historical signed moves remain unknown, not fabricated zero-performance observations.
- Durable distinct-day identities survive rolling pruning; legacy already-lost identities handled conservatively.
- Malformed counters/JSON/date evidence blocks eligibility and remains available for diagnosis.
- Initial history seeding uses paginated durable outcomes, not the newest 1,000 dashboard entries.
- Grading, gate counts and pending removal are transactional so a failed write cannot double-count an outcome after retry.
- Expiry endpoints delayed more than 60 seconds are censored/excluded; accepted outcomes record target, actual time and lag. This is a fixed tolerance policy, NOT exact timestamp historical-label reconstruction.
- Existing 100/55%/3-day gate is explicitly a PAPER experiment milestone, never proven economic edge.
- Agent tests use scoped fake keys and injected transports, independent of operator credentials.

## Remaining gates — not complete

1. Reconcile actual venue funding rate units, eligibility, timing and rounding. The subsequent continuation replaces continuous approximation with explicit modeled history events, but independent venue corroboration remains required.
2. Fully segmented gap-aware own-capture/historical research; complete attempts ledger across manual selections, prompts/models, sweeps and repeated holdouts.
3. Independent heldout/forward evidence package with real provenance, dependence-aware analysis, realistic costs and capacity. There is deliberately no replacement automatic research-approval installer until this contract exists.
4. A frozen candidate with positive prospective net economics. Existing strategy failures are not overturned by fixing the simulator. No new profitable-strategy claim is made.
5. 24-hour real feed acceptance and multiweek recording; current fixture tests cannot substitute for elapsed real observations. Prior operator deferral not silently overridden.
6. Subsequent continuation adds isolated chain-300 signer transport, durable nonce/lease OMS and unknown recovery, all locked away from server/fleet. Actual WASM/testnet validation, trusted account/fill reconciliation, scale-normalized risk, native protection and independent exposure watchdog remain required. See NEXT_STAGES.md.
7. Verified remote object durability before local prune, encrypted offsite evidence, clean-machine restore drills and critical-alert durable delivery.
8. Total account/portfolio economic risk including cash flows, correlated positions and cash-flow-adjusted day boundaries. Fleet brake is not a substitute for the central account risk engine.
9. Probability calibration, horizon/version cohorts and prompt/model reproducibility; corrected return-interval wording alone does not implement calibrated confidence.
10. Affordable ring-fenced pilot mandate, legal/access/tax review and prospective paper/testnet/live observation. These require operator facts and elapsed evidence.

## Verification

- Clean-clone baseline: typecheck passed; 355 passed / 13 failed out of 368 tests.
- First integrated repaired snapshot: `bun run check` passed (401 tests, typecheck, Vite build).
- Browser acceptance: `bun run test:e2e` passed all 6 desktop/mobile Edge workflows using isolated fixture servers, not the operator's running terminal.
- Subsequent larger snapshot: 421 passed / 0 failed with `bun test ./tests --timeout 20000`, typecheck and build clean. One earlier default-timeout run failed only because a source-bound integration test exceeded Bun's 5-second default; no production timeout, health or risk threshold was loosened.
- Final stable source tree: **422 passed / 0 failed**, 2,789 assertions across 56 files with `bun test ./tests --timeout 20000`; `bun run typecheck`, `bun run build`, and `git diff --check` all passed. Only Git line-ending normalization warning remained.
- Regression coverage includes replay stale gaps, candle accounting, funding ineligibility, promotion, equity brake, durable journal, gate migration and atomic/censored agent outcomes. Browser tests ran before the last backend-only accounting/gap additions; full final unit/integration verification includes those additions.

Testnet, real venue funding reconciliation, actual 24-hour acceptance and real-money profitability have NOT been validated.
