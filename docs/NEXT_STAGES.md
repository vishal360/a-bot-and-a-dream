# Next implementation stages — 2026-11-11

Requested order: funding settlement, multiple strategy candidates, durability/recovery/alerts, execution foundations. The operator owns the 24-hour run. This work does not initiate that run, trade, fund an account, deploy, or overwrite the original checkout.

## 1. Funding settlement model

The previous stats-rate continuous approximation has been replaced by discrete hourly history events. The evidence format preserves market identity, epoch-second boundaries, observation time, full hourly coverage and a canonical SHA-256. Public `value` is interpreted as quote per base unit and `direction` as payer under the existing disclosed simulator policy; exact integer funding math is shared with the paper ledger. Settlement applies to holdings immediately before a boundary, before same-timestamp fills. These semantics are assumptions until independently corroborated against account/transaction evidence; a source hash or collection time is not verification of venue finality, eligibility or rounding.

Public history export (read-only, fixed mainnet public endpoint, no keys):

```
bun run scripts/fetch-replay-funding.ts --market-id 0 --symbol BTC --from <epoch-seconds> --to <epoch-seconds> --out data/funding-history.json
bun run scripts/research-promote.ts --capture <capture.json> --market BTC --funding data/funding-history.json
```

All five exporter arguments are required; existing output is refused; span <=30 days; current/nonfinal/missing hours fail validation. Use historical windows whose last boundary was observed at least one hour later. Export is not trading authority, and the screen command still cannot promote. Capture history may need a wider data window than a short 2,000-frame prefix to evaluate slow candidates.

Independent venue verification still needs the evidence listed in LIGHTER_FUNDING_EVIDENCE.md. No funding strategy is declared profitable or live-approved merely because event arithmetic passes fixtures.

## Stage status

Funding stage implemented; focused funding/replay tests pass. Current stats rates no longer affect cash. Complete historical coverage is distinct from independent venue verification, which remains false.

## 3. Multiple research strategies

Four completed-minute strategies are implemented: channel trend, trend-filtered z-score reversion, moving-average pullback, and squeeze expansion. See RESEARCH_STRATEGIES.md for parameters and exact mechanics. Protective stops/targets precede warmup/spread filters. Inputs require chronological contiguous elapsed coverage, bounded quotes and completed minutes; no fabricated volume is used. All four are registered for replay and explicitly rejected by fleet creation/update and automated entry admission. Their helper source bytes are bound into artifact hashes. Research tests prove behavior, not profit.

Historical lane: provide a --configs JSON array with the research strategy IDs to research-walkforward.ts; own-capture lane adds them only with --include-research. These minute strategies intentionally refuse one-mid-per-minute synthetic context because it does not prove >=50 seconds of observed minute coverage. Use genuine 1-second history or sufficiently long raw-capture windows, not invented samples. Default 2,000-frame capture prefixes may be too short for warmup; an honest no-trades result is not a qualified strategy.

## 6. Durability, recovery and critical alerts

Implemented atomic SQLite snapshots, independent integrity checks, SHA256/byte manifests, mounted-copy readback verification and exclusive new-directory restore drills. Mount copy success is explicitly not remote proof. Default sole-copy pruning is refused; retention/disk pressure is reported. Existing archive files without new manifests are preserved and require offline reconciliation, never silently deleted. Mirror script now requires explicit source/destination arguments and copies/checks without /MOVE or local deletion. Encryption is explicitly not implemented: protect snapshots as sensitive and use provider/device encryption under operator control.

```
bun run scripts/verify-backup.ts <snapshot.sqlite>
bun run scripts/verify-backup.ts <snapshot.sqlite> --restore-to <NEW-directory>
bun run scripts/verify-remote-backup.ts <snapshot.sqlite> <configured-cloud-remote:path>
```

The opt-in remote drill requires an operator-configured direct cloud rclone backend; it uploads content-addressed bytes, downloads them to a fresh temp location and compares SHA256/length. It does not prune or auto-configure backup services. Production defaults still have no independent remote verifier. Snapshot hashing currently reads files into memory; large snapshot capacity must be measured before enabling low-memory VM backup. No actual remote upload or clean-machine operator restore has been performed in this session.

Critical health-alert/bot-halt/guard-pause notifications use a SQLite outbox populated transactionally from durable decision history, including while Telegram is unconfigured. Retries/backoff and delivery acknowledgements survive restart and ring eviction. Critical attempts take priority over informational floods. Telegram ok:false and transport timeouts fail delivery; failures are secret-sanitized. Delivery is at least once (possible duplicate after send-before-ack crash), not an operator incident acknowledgement. Status appears in /api/alerts under outbox. Configure an independent process/host monitor and second alert channel separately; a stopped host cannot deliver its own queued alerts.

## 4. Locked execution foundations

The isolated execution coordinator persists intents and conservative reservations before submission, fingerprints idempotent client IDs, allocates durable nonces under fenced per-key leases, retains unknown outcomes without blind retries, and reconciles only explicit injected venue evidence. Fresh account/chain/key/generation binding and session authorization are required; restarts revoke authorization. Account economics freshness is shared across keys and generations so stale sibling baselines cannot reopen after terminal release. Trusted session/evidence injection remains the authority boundary; this is not permanent generation retirement or cryptographic evidence authentication. Partial/terminal fills have cumulative unique identities; contradictory evidence latches a blocker. Mainnet is unconditionally refused. See EXECUTION_COORDINATOR.md.

The isolated Lighter adapter accepts only chain-300 testnet and fixed testnet endpoints, an explicitly injected official Go/WASM signer and a session opt-in. It signs exact decimal integer values, sends bounded IOC limit/market or cancellation requests without retries, and reports transaction acceptance separately from fills. Fence callbacks run immediately before signing and HTTP dispatch. See LIGHTER_TESTNET_ADAPTER.md and official https://docs.lighter.xyz/developers/getting-started/quickstart-typescript.md.

An optional testnet-execution-bridge joins the contracts with exact base/price atom conversion, limit IOC only and account/key/chain binding. It rejects mixed market product decimal scales. Its OMS notional/risk values must all use the same base-atoms × price-atoms product units, NOT dollars or USDC micros. A reviewed multi-market scale-normalization layer is still required before production risk sizing.

**Deliberately not enabled or claimed:** no execution server routes, fleet wiring, bundled/loaded signer binary or Go glue, real keys, testnet submissions, real account snapshot authority, authenticated order/fill reconciliation, liquidation/native-stop management, session UI or mainnet authorization. These are tested foundations rather than a finished live trading system. Never manufacture verified:true from an unvalidated API response. Complete account/venue reconciliation, actual WASM/testnet acceptance, exchange-native protections and operator approval are mandatory further gates; mainnet remains locked.

## Verification and handoff

Commands (PowerShell, from this checkout):

```
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
bun run typecheck
bun test ./tests --timeout 20000
bun run build
bun run test:e2e
```

## Completed verification

- Integrated execution-stage run: **525 tests passed, 0 failed; 3,477 assertions across 65 files**. Typecheck, production build and diff whitespace check passed.
- Desktop/mobile Edge browser fixtures: **6 passed**.
- Subsequent execution safety review identified stale cross-generation economics and mixed market product scales. Account economics freshness is now account-wide; the bridge refuses mixed product scales. The coordinator's final focused run passed **13 tests / 80 assertions**, and the bounded-stream adapter's final focused run passed **14 tests / 103 assertions**, with full typecheck passing.
- The final stable-source aggregate command (typecheck → full suite → production build → diff check), job pwsh-8968dae7592e44f1, was reported completed with **exit code 0** before session resumption. Its detailed output is no longer available through the resumed job registry, so no final revised test count is asserted. Finished tests were not rerun solely to recover that count.
- On resumption, the working changes were confirmed present and git diff --check passed (only the existing PowerShell LF/CRLF normalization warning).

Tests use in-memory/temp databases, fake transports/signers and isolated browser fixture servers; they do not establish venue or profitability validation.

No 24-hour run was launched. No commit/push/deploy was performed, and the original Cline checkout was not overwritten. Before moving changes there, review the diff, preserve operator data/configuration, run offline restore checks and configure independent remote backup/alerts; then carry out the operator-owned 24-hour acceptance procedure with real-money authority still disabled.
