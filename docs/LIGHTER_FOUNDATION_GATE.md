# Next gate: independently inspected read-only foundation

This gate is implemented, **not satisfied**. It neither repairs Windows nor starts
observations, changes readiness, opens the operator database, or enables orders.
It is a local evidence check, not a promise of flawless trading or profits.

## Research and prerequisite status

Official references reviewed on 2026-10-13:

- [Microsoft Windows Time tools](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings):
  `w32tm /query /status /verbose`, `/query /configuration` and `/query /peers`
  provide diagnostics. Domain members normally follow the domain hierarchy; do not
  replace that with arbitrary public peers. Service/configuration/resync actions
  require administrator review, and NTP uses UDP 123. A running service alone is
  not successful recent synchronization. No repair or clock-policy override is
  implemented by this gate.
- [Lighter funding](https://docs.lighter.xyz/trading/funding.md): hourly payments,
  positive rates charge longs, and signed payment is `-position * index * rate`.
  This does not specify the exact funding/fill boundary ordering, rounding/discount
  reconciliation or historical revision contract. Those remain blockers.
- [Lighter timestamps](https://apidocs.lighter.xyz/docs/timestamps.md): book stream
  continuity and publication freshness are separate. Trade block timestamps are
  milliseconds; transaction execution timestamps are microseconds. Sequence
  counters have distinct scopes. Acknowledgement is not fill confirmation, and
  cross-clock subtraction is not a latency measurement.
- [Lighter API keys](https://docs.lighter.xyz/trading/api.md): API keys authorize
  signed requests. A future signer therefore requires a separate isolated trust
  boundary; a read-only readiness result must never become signing permission.

Before this increment, independent file hashing confirmed all 157 files in bundle
`review-0ed420b9-76dd-4e7c-ac57-c07be89541f8`, including 116 source copies matching
the then-current tree. Its manifest SHA-256 is
`1d385d4f5841ada0d8676f7cae6f747e682319c4860661ffc3467fd8c2056ba2`.
Readable logs record 212 unit tests, 57 targeted tests, four helper tests, six browser
workflows and nine fixture drills. Its clock preflight failed with `0x80070426`.
The new source files intentionally invalidate that bundle as a **current-tree**
review; retain it as historical evidence and produce a fresh validated bundle.
All local stage timestamps remain uncertified host time.

## Independent software-review inspection

Run from `C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal`:

```powershell
bun run scripts/lighter-review-bundle.ts review-0ed420b9-76dd-4e7c-ac57-c07be89541f8
```

The verifier checks ordinary bounded paths without linked ancestors, unique file
entries, SHA-256/byte lengths, the recomputed source fingerprint, all current Git
source paths/HEAD including new files, the runtime-source subset, all twelve stage
results and exact declared commands, source/log bindings and expected exits.
Preflight may exit 1 **only as retained blocker evidence**, while legacy/failed-short
inspections must exit 1. Browser validation must follow the build. Test counts must
match summaries; fixture drill sources and process/service records are inspected.
Drill databases are not reopened or copied, and the bundle does not certify physical
storage durability or genuine runtime recovery. Hashes do not resist a malicious
local administrator who can rewrite the evidence and its hashes.

## Composite foundation check

```powershell
bun run scripts/lighter-foundation-gate.ts
```

With no evidence IDs it reports missing review/observations and current clock
status, exiting 1. Use `--help` for the three explicit ID arguments: `--bundle`,
`--short`, and `--sustained`. IDs are restricted to their local evidence directories;
there are no arbitrary paths, clock bypass, automatic repair, or order switches.

The completed foundation requires:

1. A freshly packaged current-source software review passing independent inspection.
2. A successful current OS-clock preflight under the unchanged policy.
3. A **separate completed 60-second** observation, fully inspected from disk.
4. A **separate completed 24-hour** observation started after the short run finishes.
5. Both reports matching current observer/dependency/lockfile hashes and the same
   symbol/market/precision universe. Metadata is bound to the exact report bytes
   inspected; changing sources during the gate fails closed.

The existing observer PID 6308 began on older sources; do not kill it, read its live
database, reuse its partial captures, or relabel it as patched acceptance. Before
any validation run, review active runner identities and `.lock` directories. Never
automatically delete a lock. If sources change, rerun validation and packaging.

Administrator-approved time repair remains an external prerequisite. After repair,
run `bun run scripts/lighter-acceptance-clock.ts`, inspect its result, then conduct
and inspect the short run before starting the sustained run. Neither time repair
nor genuine observations were authorized/executed by this implementation.

## Route to the main automation work

Passing this foundation does **not** satisfy operational recovery, perpetual
accounting, strategy validation or trading authority. The next increments are:

1. Genuine recorded runtime recovery evidence and funding/overnight reconciliation.
2. A frozen versioned strategy and risk policy, supported markets/order types, cost
   model, provenance-verified data, untouched holdout and walk-forward comparisons.
3. An isolated **shadow-only proposal worker** with bounded resources, expiry and
   audit, but no trading-state write access, keys or executor connection. This is
   the first automatic strategy-processing boundary, not automatic ordering.
4. Measured paper-forward evaluation, then explicit bounded paper promotion through
   existing central reservations/risk/execution; no alternate fill path.
5. Live operation remains a separate eligibility, signer, reconciliation, alerting,
   recovery and capital-authorization project.

No strategy, leverage, capital, fee tier, model provider or budget is silently
chosen. See [automation roadmap](AUTOMATION_ROADMAP.md),
[funding evidence](LIGHTER_FUNDING_EVIDENCE.md) and [live readiness](LIVE_READINESS.md).