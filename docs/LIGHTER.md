# Lighter integration status

**Revised direction:** use public mainnet data for an independent local paper simulator;
no venue signing or testnet execution in the current scope. See [paper plan](PAPER_MAINNET.md).
The historical signer/testnet roadmap below is deferred, not a prerequisite for local simulation.

Public mainnet and testnet perpetual-market quotes are polled independently every 10 seconds. The UI distinguishes mark, index and last-trade price. A recent HTTP receipt is not proof that the last trade or venue price is recent. Testnet prices may differ significantly from mainnet. Charts contain observations received since server startup, not fabricated historical candles.

MES is not a Lighter BTC proxy or a substitute equity-index perpetual: no MES price is displayed without a CME futures feed.

The Connections & API page saves a replacement API private key in the existing AES-GCM vault together with network, account index and API-key index. The key pasted into chat was not saved or used. Rotate it. Public account reads verify account existence, not private-key ownership. Mainnet remains read-only.

## Still required before testnet execution

1. Install and pin the official Lighter signing SDK and native signer; the current project has only Bun/React dependencies. Do not invent signatures or use ordinary HMAC signing.
2. User supplied testnet account index **1229** and API-key index **4**; these are now connection-form defaults, not authenticated credentials. Enter a rotated replacement key locally and verify it using the official signer client.
3. Implement precision/minimum-size validation using venue market metadata, serialized nonce handling, client order IDs, order acknowledgment, fills, cancellations and restart reconciliation.
4. Separate venue account P&L from the legacy synthetic ledger; include funding and liquidation events. Risk-gate orders before signing and persist unresolved submissions.
5. Run an explicitly authorized tiny testnet order/cancel/fill reconciliation exercise, including timeout and restart cases. Never infer fills from submission success.

The legacy synthetic engine remains in code for regression tests but is disabled in the production HTTP server. Legacy paper order/flatten routes reject requests. Existing synthetic history is retained, labeled synthetic, and is not revalued at new venue prices.

## Roadmap gates

See [step 2–4 acceptance gates](PREREQUISITES.md) for the reconciled checklist.
`GET /api/readiness` explicitly reports these steps incomplete and agents disabled.
`GET /api/risk/execution` reports the disconnected internal risk foundation: durable
integer-micro-unit reservations, transactional aggregate allocation/leverage checks,
immutable generation/day opening baseline and an independent cash-flow-adjusted loss
halt. Snapshots invalidate on restart and connection changes; reservations and the
loss halt persist. This foundation has no venue adapter, reservation-release path,
authentication bridge or order-submission endpoint. Public account reads cannot feed
it as authenticated reconciliation. Passing unit tests does not satisfy venue acceptance.

Operational foundation is not complete until authenticated execution and reconciliation are verified. Browser interaction/visual E2E verification remains outstanding. Broker/data/risk selection needs user confirmation of jurisdiction, eligibility, capital and loss limits. Do not call steps 2 or 3 complete on a successful build alone.

Step 4: strategy validation with real historical data, realistic fees/funding/slippage, walk-forward and out-of-sample evaluation, then a sustained testnet forward run. No mainnet execution until those gates pass.

Official references: https://docs.lighter.xyz/ and https://github.com/elliottech/lighter-python . API hosts: https://mainnet.zklighter.elliot.ai and https://testnet.zklighter.elliot.ai . Public endpoints used: `/api/v1/orderBookDetails`, `/api/v1/account?by=index&value=ACCOUNT_INDEX`.

## Local statistics sessions and strategy transparency

Portfolio & risk includes a persisted 0–100% combined margin-allocation slider. Default is 0% (no new exposure intended). The saved percentage applies to the entire current account equity, never a fixed $100: combined margin budget = current equity × allocation percentage / 100, across all agents/positions with future pending-order reservations counted too—not leveraged notional or a per-order allowance. The preview now uses the configured account's public `total_asset_value` snapshot, with account/network identity and read time. It rejects snapshots older than 30 seconds, future timestamps, mismatched identity and missing/invalid equity; no illustrative or synthetic balance is substituted. Refresh reads the account from the venue; polling the preview does not itself refresh venue data. The preview is not remaining buying power or authenticated, reconciled execution equity. The policy survives stats reset and database reopen. Lowering it never closes positions. Leverage is capped at 20× in the policy, with per-position sizing/leverage deferred. Daily-loss policy is 6% of UTC start-of-day equity including unrealized P&L, fees/funding and cash-flow adjustment. These are saved configuration intentions, not functioning venue risk controls; execution remains disabled. Future enforcement must recompute against fresh reconciled equity/margin before each submission, with reservations, concurrency controls and a durable daily-loss latch. The daily threshold cannot guarantee maximum losses.

Analytics and System & audit include an archive/reset control requiring `ARCHIVE AND RESET`. A SQLite transaction preserves all fills, marks, redacted connection summaries, analytics, alerts, heartbeats and bot metadata in `ledger_archives` inside `data/terminal.sqlite`, then clears the active local ledger and observation history. Credentials, risk, research runs, audit and halt remain unchanged. Archive JSON is downloadable. No venue calls occur. Recorded open positions block reset to preserve cost basis. Archived fill IDs remain deduplicated so repeated imports do not restore old P&L. Back up the database separately; an archive in the same file is not a disaster-recovery backup.

The Strategy & trade journal distinguishes the long-only channel breakout research backtest from the disabled five-observation synthetic momentum runner. It displays originally stored fill reasons without inventing signal evidence. No strategy is deployed to Lighter.

Due-diligence findings: synthetic production execution is disabled; signer authentication, precision validation, durable order/nonce management, fills/funding reconciliation and browser E2E remain outstanding. Legacy paper risk policy is not a Lighter execution gate. Connections & API again exposes the existing read-only broker and ingestion tools alongside Lighter.

Step 4 remains gated: choose venue instruments/timeframes and approved risk limits; acquire provenance-verified historical OHLC and funding, model fees/slippage/liquidity, freeze training and holdout windows, perform walk-forward evaluation against baselines, then forward-test on authenticated testnet. Synthetic backtest results cannot pass this gate.