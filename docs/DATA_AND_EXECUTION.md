# Data, venue and manual execution direction

## Recommendation

Use Lighter's own mainnet order book/trades/mark/index/funding as the execution
and valuation authority. Add Binance USD-M perpetual market data as an optional
signal/context feed, then Bybit as a further independent comparison if measurement
shows value. Do not merge their books into executable Lighter liquidity.

For strategies holding seconds to minutes or longer, zero-fee Standard Lighter
is a reasonable candidate to test. It is not the lowest-latency execution choice
by definition. Its published tier adds 300 ms taker and cancel/modify latency.
For sub-second scalping or frequent maker repricing, benchmark an eligible CEX
and Lighter Premium; compare net results, not fees alone.

Keep the execution chart explicitly venue-labeled. Binance BTCUSDT perpetual,
Bybit BTCUSDT perpetual, and Lighter BTC are different contracts/books and may
diverge. Maintain explicit market mappings, quote currencies, size multipliers,
funding intervals and basis checks. Missing mappings remain Lighter-only; never
map markets just by matching a ticker string. A reference-feed failure must not
silently substitute its prices into fills, stops, or account valuation.

## Verified documentation, not latency benchmarks

- Lighter Standard: 0 maker/taker fee, 300 ms taker and cancel/modify delay;
  maker delay 0 ms. Premium at no stake: 0.0040% maker / 0.0280% taker,
  140 ms taker delay; no additional cancellation/post-only placement delay.
  These are published tier terms, not measured submission-to-fill latency.
- Bybit public linear/inverse book: L1 10 ms, L50 20 ms, L200 100 ms,
  L1000 200 ms publication frequency. This is not internet delivery latency.
- Binance's official USD-M connector documents per-symbol book ticker as
  real-time and diff depth as 100/250/500 ms. The developer website was
  challenge-blocked during review, so the official repository was used as a
  fallback. Verify the current stream specification before implementation;
  do not rely on a legacy all-book-ticker stream's cadence.

References reviewed during this change:

- https://docs.lighter.xyz/perpetual-futures/fees.md
- https://apidocs.lighter.xyz/docs/market-data.md
- https://apidocs.lighter.xyz/docs/timestamps.md
- https://apidocs.lighter.xyz/docs/websocket-reference.md
- https://apidocs.lighter.xyz/docs/rate-limits.md
- https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook
- https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/websocket/um_futures/websocket_client.py

## Lowest-latency architecture to build next

Sequenced order-book and market_stats ingestion are now implemented as a **read-only
public feed / local paper authority**, with recovery, bounded durable diagnostics and local
processing metrics. See [streaming scope and promotion gate](LIGHTER_STREAMING.md).
Manual paper now uses the stream with no REST execution/valuation fallback. Browser
account state is pushed by SSE. Broader strategy/venue execution remains a target.

1. Persistent backend WebSocket subscriptions, never browser polling in the
   strategy/execution path. Start with all-market summary data, then detailed
   book/trade subscriptions for the selected market, positions, pending orders
   and a bounded strategy universe. Shard within documented subscription limits.
   The published Standard REST allowance is 60 requests per rolling minute;
   polling every market's depth cannot scale. Implement shared rate budgeting,
   backoff/jitter and observable 429/405 handling instead of more frequent REST.
2. Lighter snapshot/delta validation: `begin_nonce` must equal the previous
   `nonce`. `offset` is not the continuity counter. Stop matching on gaps,
   disconnects, invalid/crossed books or stale inputs; resubscribe to a snapshot.
3. Record venue execution/publication times separately from local receive time.
   Lighter frame timestamps are milliseconds; `transaction_time` and book/ticker
   `last_updated_at` are microseconds. REST orderBookOrders transaction_time is
   currently unpopulated/zero; receipt time cannot prove venue-event freshness.
4. Record bounded latency distributions: receive-to-signal, signal-to-risk,
   intent-to-submit, submit-to-ack and submit-to-fill separately. Use monotonic
   local clocks for measured durations; venue/client age needs clock-offset care.
5. Measure from candidate hosting regions before choosing a VPS. Monitor p50,
   p95, p99, disconnects, sequence gaps, spread/depth and cost for actual sizes.
   No venue or region is declared fastest without these results.
6. Deterministic risk/order service in the fast path. AI agents propose bounded,
   versioned intents; LLM inference never handles tick-by-tick stop execution.

## Implemented manual increment

- Dynamic active Lighter perpetual market selection using venue metadata.
- Independent average-cost inventory by symbol, one shared paper cash balance,
  allocation and gross exposure cap; never pool different asset quantities.
- Position size, average entry, open P&L in dollars/percent and realized P&L per
  partial exit. Open net P&L includes remaining entry fees, excludes exit fees.
  Separate entries in one symbol net together; they are not independent lots.
- Market depth IOC and price-capped limit IOC. Unfilled remainder is canceled;
  local pre-settlement cancellation is available, but no resting GTC/maker queue,
  order amend or venue cancel-latency model is represented.
- Shared durable IOC reservations, terminal settlement/release, canonical intent
  deduplication and fail-closed restart reconciliation; see [lifecycle](PAPER_ORDER_LIFECYCLE.md).
- 25/50/75% reduction quantity presets and explicit market close per position.
- Persisted position-level stop-loss/take-profit, monitored on validated stream
  updates and a one-second watchdog while enabled. A mark-price hit attempts a reduction against
  fresh depth after the modeled delay; a partial/rejected exit remains armed.
  Once triggered, the exit stays latched across price rebounds until closed
  or explicitly removed/replaced by the operator.
  Full close removes protection; neither sibling can create a short position.
- Restart retains inventory/protection but disables automatic monitoring until
  explicitly re-enabled. A disconnected feed cannot trigger from cached quotes.

The subsequent [perpetual accounting increment](PAPER_PERPETUAL_ACCOUNTING.md)
adds signed long/short local paper, history-derived funding after a one-hour delay,
cross-account margin thresholds and approximate depth-IOC liquidation. Leverage
defaults to 1× and is capped at 20× and venue metadata. No venue orders, external
signal feeds or agents are enabled. Funding timestamp ordering and venue-equivalent
liquidation remain unverified. The one-second IOC
throttle remains unsuitable for low-latency trading. Stop execution is delayed by
the configured simulation latency and matcher lock; checks can be slower across
markets/network failures. They cannot protect through downtime
or guarantee a stop price. Existing fee assumptions are preserved, not silently
changed to zero on an existing account's history.

## Promotion order

### Latest manual recovery and display fixes

The activation error was traced to a durable delayed-funding baseline halt, not an
order-placement/network error. The manual workspace now offers explicit audited
baseline reconciliation; it preserves the locked original and never lowers the risk
threshold. See [accounting policy](PAPER_PERPETUAL_ACCOUNTING.md). New exposure and
buying power remain blocked during unresolved baseline/funding/recovery checks.

Previously a transient invalid/disconnected feed returned an empty quote object, so
bid/ask/spread/mark/index/last/funding disappeared together. A bounded in-memory cache
now retains **only previously validated, durably recorded quotes**, keyed by exact
market identity. During reconnect/staleness they stay visible in amber as **stale /
display only**, with the feed's reported cause; startup with no sample stays empty.
The cache is separate from `read()` and cannot supply orders, valuation, stops or
liquidation. No REST fallback or relaxed timestamp/sequence checks were introduced.
Network interruption, stale stats/books, host/server clock offsets and validation
faults can all invalidate a feed; a blank panel alone did not identify which one.
Account-push disconnects likewise retain the last snapshot and block new exposure.

A fresh isolated 60-second BTC/ETH read-only mainnet sample completed with 100%
observed health, 2,036 accepted frames, 255 trade frames, and zero disconnects/gaps/
invalid frames/recording failures. Snapshot-rooted replay passed. This is a short
sample only, **not** sustained 24-hour acceptance or proof of network reliability.
See [funding evidence review](LIGHTER_FUNDING_EVIDENCE.md) for the next gate.

The final clean offline runner completed after the patches: TypeScript, **152 unit
tests** (1,094 assertions), production build and **six desktop/mobile Edge workflows**
all exited 0. The new recovery workflow checks confirmed baseline reconciliation,
manual activation, stale quote retention, blocked opening during reconnect and fresh
recovery. Staged whitespace checks passed. These fixtures prove software behavior,
not exchange settlement semantics or 24-hour runtime readiness.

The operator's local paper account was backed up with SQLite integrity `ok`, then
reconciled through the new endpoint: HTTP 200, original baseline and fills preserved,
baseline/funding unblocked, order recovery reconciled and fresh validated feed.
Manual paper remains paused for explicit operator activation; agents/live stay off.

The operator reports the earlier manual buy/reduce/P&L workflow accepted. New
controls need separate acceptance. Sequenced feed/recording and a local IOC lifecycle
with paper reservations/reconciliation are implemented. Validated public trades and
bounded snapshot-rooted replay prefixes now add [evidence tooling](LIGHTER_EVIDENCE.md),
not complete historical coverage. Next: conservative resting-limit queue evidence
if required, validate the implemented perpetual accounting against exchange evidence,
verified daily baselines and sustained failure/forward validation,
then one isolated shadow agent. Paper stream execution integration and mark/index/
last-trade/funding display and dedicated trade recording are implemented. Complete
trade continuity/coverage, verified funding timestamp semantics, calibrated liquidation
and sustained validation remain.
Bounded autonomous paper order authority is
a separate gate; live signing is outside this change.