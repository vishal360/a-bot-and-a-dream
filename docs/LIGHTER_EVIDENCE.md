# Public trades and bounded replay evidence

This increment is **read-only evidence tooling**, not strategy approval or a new
execution model. Live execution and agents remain disabled. Paper fills still walk
fresh sequenced depth after modeled latency; trades cannot create fills, replenish
simulated liquidity, release reservations, or authorize orders.

## Public trade recording

The production public socket now also subscribes to `trade/{market_id}` for the
selected market and held-position markets. Regular and liquidation lists are
validated together. Identity, venue price/size precision, event type, maker direction,
block height/hash and timing are checked before durable publication. Monetary sizes
and prices are recorded as integer-unit strings using the capture's venue precision.
The original wire payload remains in the diagnostic journal and replay capture.

- `Trade.timestamp` is **block time in milliseconds**.
- `transaction_time` is **execution time in microseconds**; zero is unavailable.
- The documented trade envelope has **no publication timestamp**. Local receive
  wall/monotonic clocks are recorded separately, not presented as network latency.
- Old block times are allowed: a received record does not prove recent trading.
  Quiet trade channels do not invalidate otherwise fresh depth/stats, nor can
  arriving trades make stale depth or stats fresh.
- Trade nonces must not regress within one connection. Nonce jumps are **not**
  interpreted as gaps or proof of complete coverage: the reviewed contract does
  not provide the book's `begin_nonce` continuity rule for trades.
- Identical `(market_id, trade_id)` records are deduplicated. Conflicting normalized
  records are rejected, leave the retained record unchanged, and invalidate the
  public connection. This protection covers retained records, not evicted history.
- Malformed input closes the connection and captures its last accepted prefix.
  Recording failures invalidate paper authority and latch ingestion off until
  storage is repaired and the process restarted.

## Snapshot-rooted captures

Each connection opens a capture with immutable venue metadata, source URL, stale
threshold and required stats mode. Accepted book snapshots/deltas, stats and trade
frames append in local receive order. Diagnostic logging and accepted capture/trade
writes share one SQLite immediate transaction; failure rolls them back together.
Rejected raw frames remain diagnostic evidence but are not applied during replay.

Captures retain their initial snapshots even after the rolling diagnostic journal
evicts them. They are **bounded prefixes**, not continuous historical archives:

| Bound | Default |
| --- | --- |
| Retained connection captures | 4 |
| Frames per capture | 2,000 |
| Raw UTF-8 bytes per capture | 8 MiB |
| Recent normalized trade records, all markets combined | 5,000 |
| Trades per frame, both lists combined | 1,000 |

Reaching a frame/byte bound seals a `limited` prefix. Later live frames still enter
the rolling diagnostic journal and recent trade store, but **not** that capture.
No reconnect is forced solely to obtain a new capture. Watch changes, disconnect,
stale data or an explicit stop close the capture with a reason. Unfinished captures
become `interrupted` on restart; they are never resumed. Retention evicts entire
old captures and their frames, not roots from a surviving capture. Export evidence
you wish to keep before retention removes it. SQLite file/WAL size is not a hard
disk quota; deleted pages may remain allocated.

## Inspection and replay

All routes are loopback-only **GET** inspection routes under the existing host
boundary. There is no upload, risk mutation, capture-resume or promotion endpoint.

- `/api/feeds/lighter`: existing health plus trade receipt/nonce and evidence bounds.
- `/api/feeds/lighter/trades?marketId=1`: at most 100 normalized retained records;
  discover market IDs from metadata, do not assume this example's BTC mapping.
- `/api/feeds/lighter/captures`: manifests, limits and explicit safety flags.
- `/api/feeds/lighter/capture?id=<capture-id>`: export manifest, ordered raw frames,
  receive clocks and a SHA-256 checksum.
- `/api/feeds/lighter/replay?id=<capture-id>`: reconstruct the retained prefix without
  touching the order lifecycle, ledger, reservations or transport.

For offline inspection, save the capture GET response as a JSON file outside the
source tree, then from `C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal`:

```sh
bun run scripts/replay-lighter.ts <absolute-path-to-capture.json>
```

Replay verifies checksum, declared sizes, receive order, monotonic clocks, venue
precision, market identity and snapshot/delta continuity using the same book/stats/
trade validators as ingestion. It reports snapshot/stats coverage, terminal capture
boundary, unique trade count, top-eight final depth and a deterministic full-state
hash. Missing per-market roots/stats are reported, never upgraded to readiness.
`validated-prefix` means the retained frames validate; it does not mean a complete
session. Final freshness is evaluated at the last captured receive clock, **not now**.
Reconstructed data can never restore live book continuity.

The checksum detects accidental changes relative to the export, not tampering by
someone able to replace both payload and checksum. Local databases/audits are not
signed attestations. Cross-channel trade/book event order, downtime history, historical
coverage, replay-based P&L, queue position and replenishment remain unproven.

## Validation and remaining gates

```sh
bun test tests/lighter-evidence.test.ts
bun run scripts/verify-lighter-evidence.ts
```

The full runner writes ignored `evidence-verification.log` and `evidence-*.log` with
actual child exit codes for TypeScript, all tests, production build, desktop/mobile
Edge acceptance, HTTP/static smoke and whitespace checks. Fixtures prevent venue
requests; unit tests also inspect disk reopen, capacity eviction, corruption,
disconnects, stale books, conflicting trades and atomic recording rollback.

Full validation completed on **2026-10-12 at 10:12 UTC**: TypeScript, **109 tests
across 15 files** (including 17 new evidence tests), production build, **four
desktop/mobile-sized Edge workflows**, production HTTP/static-asset smoke and
`git diff --check` all exited 0. The evidence suite includes a real loopback
WebSocket and offline exported-file CLI replay. This is automated software
validation, not sustained mainnet feed acceptance or physical-device testing.

This does not complete funding settlement, shorts/liquidation, verified UTC opening
baselines/cash flows, resting-limit queue evidence, sustained failure/forward
validation or agent promotion. No mainnet trade-stream runtime sample is claimed
by deterministic validation.

Protocol references reviewed:
- https://apidocs.lighter.xyz/docs/websocket-reference
- https://apidocs.lighter.xyz/docs/timestamps
- https://github.com/elliottech/lighter-python/blob/main/lighter/models/trade.py