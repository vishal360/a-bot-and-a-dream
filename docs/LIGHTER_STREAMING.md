# Lighter validated public feed and paper authority

## Boundary

The backend opens one persistent **read-only mainnet** WebSocket for the selected
paper market and open-position markets, using venue-discovered IDs and precision.
The watch set contains the selected market and every open-position market. REST
discovers metadata at most once per minute; depth, marks and protection do not poll REST.
No signer, credentials, authenticated channels or transaction messages are used.

Validated, durably recorded WebSocket depth **and** fresh `market_stats` are now
the manual paper authority. Fills walk the sequenced book after modeled latency;
venue mark values holdings and triggers protection. Index/last trade/funding are
display-only. No REST, bid/mid or external-price fallback is allowed. Public frames
never replenish simulated consumed liquidity or release risk reservations. Agents
and live trading remain disabled. Operator acceptance of the expanded manual
controls is still outstanding; automated browser checks are not user acceptance.
The subsequent [trade/replay evidence increment](LIGHTER_EVIDENCE.md) also subscribes
to public trades and preserves bounded snapshot-rooted connection prefixes separately
from this rolling diagnostic journal. It does not establish complete trade coverage.

## Health and recovery

`GET /api/feeds/lighter` reports connection state, health, market books, nonce,
timestamps, gap/disconnect/stale/invalid counters, limits and latency samples.
Only healthy books expose their top eight bid/ask levels; overall authority health
also requires fresh stats for all watched markets. Health is evaluated
on every read as well as the backend timer; no timer delay can make a stale book
appear healthy. This route is observational and offers no execution endpoint.

- Subscribe to `order_book/{market_id}`. `subscribed/order_book` is a full
  replacement; `update/order_book` contains absolute sizes, with zero deleting
  a level. Wire values are used, not multiplier-adjusted SDK display values.
- Subscribe to `market_stats/{market_id}`. Require matching `market_stats:id`,
  symbol and market_id; positive bounded string mark/index/last prices, bounded
  signed string funding/current funding rates and valid funding timestamp.
  Publication and documented funding timestamps are milliseconds. Funding rates
  are displayed in venue percentage units; current rate estimates the next payment.
  Missing/stale stats blocks paper matching and removes account marks. Regressing
  publication times or invalid stats invalidate the whole connection.
- Require `begin_nonce === previous nonce` and non-regressing safe-integer nonces.
  `offset` is **not** continuity. Same-nonce heartbeats may not change state.
- Validate price/size precision with integer arithmetic, finite bounded economics,
  duplicate normalized prices, both nonempty sides and uncrossed best quotes.
- Disconnect, sequence gap, malformed/crossed/oversized input or stale book clears
  **all** books on this connection. Reconnect with capped exponential backoff and
  jitter, and subscribe again for snapshots. Prior socket callbacks are fenced.
  No REST fallback, buffered-delta recovery or previously persisted book is used.
- Use monotonic local time for receive age. The default 5-second stale threshold
  is conservative: quiet markets can resnapshot unnecessarily. Pongs do not
  freshen books. A 10-second connection/snapshot deadline, 30-second client ping
  and 90-second connection inactivity deadline supplement book freshness.
- Require envelope publication time in milliseconds. Publications older than
  5 seconds or more than 2 seconds in the future are rejected; synchronize the
  host clock. This is a clock-offset-sensitive guard, **not** measured network
  latency or proof of underlying market-event freshness. Book `last_updated_at`
  remains separate integer microseconds; missing/zero execution time is null.
- Bounds: 32 markets per socket, 5,000 levels per side, 131,072 characters per
  frame. Invalid/oversized watch replacements clear the server watch set rather
  than quietly monitoring a subset of positions. More markets require sharding
  and rate/subscription budgeting before promotion.

## Recording and metrics

`lighter_feed_journal` in the existing SQLite database records connection epochs,
watch metadata, bounded raw book frames with accepted/rejected outcome, local wall
receive time, and disconnect reasons. Validation and synchronous durable recording
complete before control returns and a healthy update can be observed. SQLite uses
the existing WAL/FULL durability policy. A recording error clears books and latches
ingestion off; repair storage and restart before collecting more data or matching.
Restart always requires a new snapshot, even when journal history is present.

Retention is the latest **5,000 journal records**; old rows are deleted atomically
with insertion. This is a bounded diagnostic tail, **not a complete historical
replay dataset**: retention can remove the snapshot preceding retained deltas.
It is separate from paper fill evidence, which is unaffected. SQLite file/WAL
size is not strictly bounded by row count and normal backup/disk monitoring still
applies. A dedicated asynchronous recorder and complete replay segments remain
future work; synchronous storage can itself delay ingestion under disk load.

Bounded rolling distributions (latest 512 samples, p50/p95/p99) use a monotonic
clock: receive-to-apply, durable-record, receive-to-recorded, inter-book-arrival.
The first three describe **local processing**; the last describes arrival cadence,
not one-way delivery latency. No submission/ack/fill latency is claimed because
there is no venue order transport. Metric samples include no cross-clock subtraction.

## Browser account push and margin

`GET /api/paper/events` sends named `paper` SSE snapshots. Clients reconnect via
EventSource; there is no periodic account fetch. Updates are coalesced at 250 ms,
with a one-second health/settings watchdog, a 16-client cap and two queued frames
per client. Slow clients are evicted, not buffered indefinitely. Same-origin/host
checks apply; this remains a local-only service, not authenticated multi-user trading.
An interrupted push stream disables browser buys even if the last displayed quote
looked fresh. The server independently enforces freshness after IOC delay.

Leverage defaults to 1× and is capped by venue initial-margin fraction and 20×.
Open-position leverage cannot change. See [margin accounting](PAPER_MAINNET.md).
This is a bounded long-only simulator, not a full perpetual account: no funding
settlement or liquidation. There are no venue orders, signers or agent authority.

## Verification and next gate

From `C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal`:

```sh
bun test tests/lighter-stream.test.ts
bun run scripts/verify-manual-controls.ts
bun run scripts/verify-lighter-stream.ts
```

The regression runner writes individual UTF-8 logs with explicit exit codes and
`manual-verification.log`. Browser fixtures intercept WebSockets as well as REST;
the stream suite also exercises a real loopback WebSocket server. The optional
last command discovers BTC/ETH IDs from mainnet, records a full 20-second sample of
read-only data to an isolated temporary database and writes
`lighter-stream-probe.log`; it never starts the terminal or touches operator state.
It is a short connectivity/continuity sample, not sustained or regional benchmarking.

### Recorded validation for this increment

The full runner completed on **2026-10-11 20:56 UTC** (2026-10-12 local time):
TypeScript, **78 tests across 13 files**, production build, **two Playwright workflows
(desktop/mobile Edge)**, production HTTP/static-asset smoke and `git diff --check`
all exited 0. Browser checks include leverage saving/open-position locking,
account changes delivered by SSE without polling, persistence/restart pause,
multi-market IOC orders and halted reductions. This is automated evidence, not
operator acceptance or physical-device validation.

A separate read-only BTC/ETH mainnet probe ran for 20 seconds at **20:55 UTC**:
**535 accepted frames**, one connection, zero gaps/disconnects/stale/invalid frames
or recording failures, ending with healthy books and fresh market stats. Dynamic
venue discovery returned ETH market 0 and BTC market 1; the application never
hardcodes these mappings. The probe did not place orders or touch operator data.
Evidence: ignored `manual-verification.log`, `manual-*.log`, `validation.log` and
`lighter-stream-probe.log` in the project root.

Before agent/venue execution: sustained disconnect/restart/load drills, complete
archived replay coverage beyond bounded prefixes, shared rate budgeting, verified
liquidity consumption/replenishment semantics, complete trade continuity and funding
settlement, and the protection/shared-risk regression and user acceptance
gates must pass. The durable paper order lifecycle is implemented; an isolated shadow bot remains gated;
autonomous order authority is a separate decision.

Protocol references reviewed for this increment:

- https://apidocs.lighter.xyz/docs/market-data
- https://apidocs.lighter.xyz/docs/websocket-reference
- https://apidocs.lighter.xyz/docs/timestamps