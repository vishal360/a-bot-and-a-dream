# Funding evidence gate — reviewed 2026-10-13

This records authoritative statements separately from simulator policy. It does not
authorize autonomous paper orders or live signing.

## Official source findings

1. [Funding](https://docs.lighter.xyz/perpetual-futures/funding):
   “Funding payments occur at each hour mark.” Positive rates mean longs pay shorts;
   negative rates mean shorts pay longs. The formula is `-position * index * fundingRate`;
   positive payment is credited and negative payment is charged. The `/8` in rate
   calculation does **not** make settlement eight-hourly. These claims support the
   simulator's hourly cadence and signed economics.
2. [fundings OpenAPI](https://apidocs.lighter.xyz/reference/fundings.md): maximum
   750 records; resolutions `1h`/`1d`; timestamp int64 (example `1640995200`), strings
   `value`, `rate`, `direction`. The schema has no descriptions establishing exact
   value units, direction meaning, accrual-window labeling, revision/finality or
   position eligibility. Examples are not a settlement-order specification.
3. [positionFunding](https://apidocs.lighter.xyz/reference/positionfunding.md):
   account funding records expose timestamp, funding ID, change, discount, rate,
   position size and side. Authorization is required for main/sub-account indexes;
   public pools may omit it. This is a possible **read-only** corroboration source,
   not permission to request credentials or create venue positions.
4. [Timestamps](https://apidocs.lighter.xyz/docs/timestamps.md): WebSocket envelope
   timestamps are API-server publication time in ms; trade block time is ms and
   transaction execution time is microseconds. Ordering counters have explicit
   scopes, and cross-clock subtraction is not a latency proof. These rules do not
   establish a common funding/fill ordering at an hour boundary.
5. [Liquidations & LLP](https://docs.lighter.xyz/trading/liquidations-and-llp-insurance-fund.md):
   partial liquidation uses full-position IOC **limit** orders at zero prices,
   with up to 1% fee when execution improves on zero price. Full liquidation may
   transfer positions to LLP, otherwise ADL. Our visible-depth IOC and fixed 1%
   executed-notional surcharge remain explicitly approximate, not those venue rules.

## Evidence gathered and limits

The isolated 60-second BTC/ETH mainnet feed run reports `samplePassed=true`, rooted
replay, 2,036 accepted frames and 255 trade frames, with zero faults. The local report
is `data/acceptance/c7e35fa9-f5ea-4bb2-9e71-ee2d0418bc2e/report.json`.
It reports `sustainedFeedAccepted=false`, `automationAuthorized=false` and
`executionEnabled=false`. Its local start/end timestamps are 2026-10-12
21:40:36–21:41:37 UTC; the machine's clock is not certified by this sample.

`bun run scripts/observe-lighter-funding.ts` is a bounded public-only observation
tool. It discovers active BTC/ETH identities, saves source URLs, metadata, observed
times, parsed response JSON and SHA-256 hashes under ignored
`data/funding-evidence/<uuid>/`, and compares two recent-history responses two seconds
apart. Unchanged rows mean only **unchanged during that sample**, never “final”.
The tool has no Paper/Store, credentials, account requests, fills or readiness writes.

The first run completed successfully: both BTC/ETH recent hourly-history responses
were unchanged across the two-second comparison. Evidence is saved locally at
`data/funding-evidence/a2499ca7-4fbc-4519-b928-624dd8a31ff4/report.json`.
Eligibility, ordering and finality flags remain false. A two-second unchanged
comparison does not satisfy any of those unresolved requirements.

## Still required before promotion

- Official clarification or transaction/account-level evidence connecting a public
  history timestamp to its settlement boundary, not just the accrual interval.
- Boundary eligibility and ordering: before/at/after fills for both sides, reductions
  and close/reopen, with funding IDs, sequence/execution times and position snapshots.
- Finality/amendment contract or a declared revision policy. Repeated public samples
  across boundaries and longer windows can detect changes, not prove immutability.
- Account funding amount reconciliation, including discount/rounding policy and the
  public `value` units/direction interpretation. No guessed account data.
- Verified overnight UTC marks, durable transfer provenance if transfers are offered,
  24-hour healthy observation and disconnect/restart/storage-failure drills.

Until these are resolved, keep the one-hour delay and strict pre-timestamp holdings
as disclosed **simulator assumptions**, keep liquidation approximate and keep agents
and live execution disabled. No gate was automatically promoted by this review.