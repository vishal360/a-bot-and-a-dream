# Read-only automation preflight — no trading promotion

This increment hardens evidence collection. It does not finish the trading bot or
authorize autonomous paper orders, agents, signing or real-money execution.

## What PID 6308 means

At the read-only inspection on 2026-10-13, Windows identified process 6308 as:

```text
bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH
```

It is the older **public-feed observer**, not an order worker. Its parent is the
existing resumption runner, PID 4812. Its isolated evidence is under
`data/acceptance/a8923e7b-c22a-42a8-9cfd-98789e28f7db/`. There was no heartbeat or
final report at inspection. Being alive, consuming CPU, or writing SQLite frames
does not establish success. PIDs can be reused: always confirm command line and
creation time before any process action. Leave this process and its database alone;
it cannot establish acceptance of code patched after it started.

## New checks

- The acceptance CLI checks `w32tm /query /status /verbose` **before network access**.
  An unavailable/stopped service, malformed/localized output, local/virtual time
  source, unusable stratum, leap warning, nonzero last-sync error, synchronization
  older than one hour or reported uncertainty above 2,000 ms fails closed.
- Reported uncertainty is `abs(phase offset) + root delay / 2 + root dispersion`.
  This is a declared OS-status policy, not independent or cryptographic UTC evidence.
  It never relaxes publication freshness or observer sampling rules.
- Clock status is retained at start, approximately every 15 minutes, and end. The
  I/O remains part of real elapsed time; slow checks may fail the existing sampling
  policy. No false healthy interval is inserted. There is no `--ignore-clock` flag.
- Exact local observer/dependency/lockfile SHA-256 hashes are captured and compared
  at finalization. Editing those files during observation fails the run.
- Exact bounded metadata bytes and replay exports have file hashes. Completed
  telemetry binds the report's SHA-256, PID, start, requested duration and symbols.
- The new inspector requires that binding, source manifest, clock evidence,
  unchanged feed criteria, metadata identities and replay/hash checks. A legacy run
  is not upgraded just because today's code is better. Hashes are local integrity
  checks, not protection against a malicious local administrator.
- First/last recorded sample timestamps are included in `observation` and must be
  bracketed by the start/end clock checks. Periodic checks must be ordered, use the
  declared policy and agree with monotonic elapsed time within the unchanged drift
  tolerance. The maximum check gap is 15 minutes plus 75 seconds for heartbeat
  scheduling and the bounded query; it does not relax the 2.5-second sample limit.
- Malformed records produce structured nonzero inspection results. Duplicate clock
  fields, symlinked run directories, non-UTF-8 JSON, disabled replay stats, changed
  freshness policy and mismatched capture identities fail closed. Older evidence
  without sample-window binding cannot satisfy the patched inspector.
- Metadata resolution is all-or-nothing with unique market IDs and valid precision.
  Shutdown recording failures are carried into the failed report, while storage
  finalization failures retain an incomplete failure heartbeat where possible.
  The observer closes its isolated database even if stream initialization fails.
- `bun run test` and `bun run check` now scope unit discovery to `./tests`; use
  explicit `./tests/<file>.test.ts` paths for targeted Bun runs. Packaged test copies
  under ignored `data/` are not runnable standalone and must not be discovered.

## Host repair and safe restart order

Run from `C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal`:

```powershell
bun run scripts/lighter-acceptance-clock.ts
bun run scripts/inspect-lighter-acceptance.ts a8923e7b-c22a-42a8-9cfd-98789e28f7db
```

Windows Time was stopped (`0x80070426`). The tools above never change it. If the
machine administrator approves host-wide time synchronization, use an elevated
PowerShell session, preserving the configured/domain-approved time source:

```powershell
Start-Service -Name W32Time
w32tm /resync
w32tm /query /status /verbose
```

Do not blindly replace domain policy, register the service again, set the date by
hand, or weaken time thresholds. A clock correction can invalidate an already
running observer; do not combine its evidence with a new run. If resync has no time
data, resolve the configured source/network/permissions with the administrator.
Starting the service or a successful command alone does not satisfy the preflight.

After preflight passes, freeze the source and run a **separate** observation:

```powershell
bun run scripts/accept-lighter.ts --seconds 60 --symbols BTC,ETH
bun run scripts/inspect-lighter-acceptance.ts <short-run-uuid>
# Only after the short run is verified; keep the host awake and do not edit runtime sources.
bun run scripts/accept-lighter.ts --seconds 86400 --symbols BTC,ETH
bun run scripts/inspect-lighter-acceptance.ts <sustained-run-uuid>
```

The UUID comes from the CLI output. The inspector exits nonzero for missing,
failed, corrupt or unverifiable evidence. A completed failed report remains useful
diagnostic evidence, not acceptance. OS-clock support currently targets English
Windows status output; other platforms/locales fail closed until a tested backend
is added. Tools never open the operator database or mutate readiness.

## Final-source validation and handoff

The 2026-10-13 continuation confirmed TypeScript, **212 unit tests across 24
files** (1,577 assertions), **57 targeted tests** (464 assertions), the production
build, all nine isolated feed drills and all six desktop/mobile Edge workflows.
These are software/fixture checks, not mainnet acceptance or certified UTC evidence.
The final validation runner binds each stage to the same before/after SHA-256
source snapshot and preserves previous logs/results rather than overwriting them.
The local handoff package requires those stages to be complete, successful and
unchanged before including source copies and validation logs. It also checks
whitespace in new/untracked deliverables, which `git diff --check` alone omits.

Validation evidence is retained under `data/resumption/acceptance-hardening/`.
The source-only review bundle excludes operator/observer databases, credentials,
dependency installations and live state. It is a working-tree review snapshot,
not a commit, publication, runtime acceptance or trading promotion.

### Final-source handoff validation

The resumption helpers are intentionally under ignored `data/resumption/`; the
ordinary project typecheck does **not** include them. Two supplemental stages,
`helperTypecheck` and `helperTests`, explicitly validate these files. All twelve
stages must share the exact source fingerprint before a bundle can complete.
Stage lock directories prevent duplicate writers; do not remove a lock until its
runner's identity and exit have been checked. Archived attempts are retained.

Each completed result binds the exact stdout/stderr byte lengths and SHA-256
hashes. Packaging checks those bindings, valid stage timestamps and build-before-
browser ordering. Source paths are allowlisted and ordinary-file bounded;
symlinks, credentials, operational data and dependencies are refused. Nested
closed drill fixtures are hashed but their databases are not copied. Final
process identity and Windows Time service snapshots must be readable.

The earlier counts above remain historical reported results. For the final frozen
source, use the completed stage results and `package-result.json`, then verify the
manifest and every included file hash. A failed clock preflight is expected to be
retained as a blocker, not converted into successful observation evidence. Local
stage timestamps are uncertified host time. A review bundle is not runtime or
trading acceptance, and the manifest's disabled authority flags must remain false.

The read-only clock query still returned **0x80070426: service not started**.
No time configuration was changed, and no genuine short or sustained observation
was started. PID 6308 and operator server PID 22500 were confirmed against their
command lines and creation times and left untouched. The legacy run has no final
report; the older failed short run is rejected by the patched inspector. Both
remain unaccepted. Administrator-approved clock repair and separate verified
60-second/24-hour observations remain prerequisites, alongside the gates below.

## How far from autonomous trading?

| Milestone | Current position | What is still required |
| --- | --- | --- |
| Manual paper terminal and feed/recovery tooling | Implemented and software-tested | Operational acceptance is distinct from fixtures |
| Sustained read-only foundation | Not accepted | Verified host time, patched short and real 24-hour healthy evidence, runtime recovery evidence |
| Exchange-faithful paper accounting | Incomplete | Funding boundary ordering/eligibility, public units, rounding/discounts, finality/revision policy, overnight UTC marks and margin/liquidation reconciliation |
| Strategy ready for autonomy | Not established | Frozen entry/exit/sizing/risk policy, provenance-verified data, untouched holdout, leakage controls, costs and walk-forward comparisons |
| Shadow proposals and paper automation | Not enabled | Isolated no-write proposal worker, measured paper-forward evidence, then explicit bounded central-authority promotion |
| Small-capital live pilot | Separate future gate | Eligibility, authenticated adapter conformance, isolated signer, account/order reconciliation, security/alerts/recovery and explicit capital/risk approval |

There is no defensible completion percentage or income date. A 24-hour feed run is
only the minimum duration of **one** evidence gate, not a profitability test. Expect
strategy and paper-forward evaluation to require substantially longer, and allow
for failed candidates. A bot can lose money even when all software tests pass.

No strategy, fee tier, leverage increase, AI provider/budget, capital allocation or
venue eligibility is silently assumed. Consult [the roadmap](AUTOMATION_ROADMAP.md),
[funding evidence](LIGHTER_FUNDING_EVIDENCE.md) and [live gates](LIVE_READINESS.md).

Official references: [Microsoft Windows Time tools](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings),
[Lighter funding](https://docs.lighter.xyz/trading/funding.md),
[position funding schema](https://apidocs.lighter.xyz/reference/positionfunding.md).
The funding formula and hourly cadence are documented; the missing boundary,
rounding and finality contracts must not be invented from matching samples.