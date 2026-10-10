# Operations console (v0.2)

The terminal includes a persistent historical ledger, account-scoped analytics, broker credential vault, read-only account synchronization and authenticated external-bot ingestion. The legacy paper engine exists only for regression tests; production execution is disabled.

## Start and use

Run `bun run build` then `bun start`; open http://127.0.0.1:3000. Runners remain paused/halted, and start/order/flatten routes reject requests. Existing fills and positions persist. Pause/halt do not flatten positions. Markets displays public venue observations, not fabricated synthetic prices. Readiness is available at `GET /api/readiness`; it currently reports steps 2–4 incomplete and agents disabled.

Screens: Command center, Bot fleet, Analytics, Executions, Markets, Connections & API, Backtest lab, Strategy registry, Portfolio & risk, System & audit.

## Connections

Connections & API accepts credentials for Alpaca paper/live read-only account/fill synchronization, or Binance global spot synchronization for one explicit pair. Save credentials, then Test & sync. Sync is manual. No order-creation endpoint is implemented for these providers. Use keys with minimum scopes, no withdrawals, and IP restrictions where supported. Alpaca is not an MES futures broker. Provider access and jurisdiction eligibility remain the user's responsibility. Real credentialed integrations have not been verified against an actual account.

Secrets are AES-256-GCM encrypted in SQLite. The encryption key lives in ignored `data/vault.key`. Protect the entire directory with OS user-only permissions (Windows ACLs especially); backups containing both key and database can decrypt credentials. Key loss makes saved credentials unreadable. Secrets are not sent in snapshots or audit logs. The application still has no multi-user login and binds loopback: **never expose it publicly**.

Imported provider accounts remain separate from internal paper. A connection attributes all imported fills to the selected bot; use external ingestion for reliable per-strategy attribution. Alpaca fill activity does not include complete fee data here, so imported fees are recorded as zero and labeled unknown/unprovided in fill reasons. Binance fees in non-quote assets cause synchronization to stop instead of inventing net P&L. Re-sync is idempotent; conflicting reused IDs are rejected. Pagination has safety limits; partial imports are retained and failed synchronization is flagged. Imported history may omit initial inventory, deposits, corporate actions or non-trade activity; broker-reported account balances/positions remain the reconciliation source of truth.

## External bots

Generate an ingestion token in Connections & API. It is shown only in the generation response; only its hash is persisted. Rotation revokes the old token. Send JSON requests with `Authorization: Bearer TOKEN` to:

* `POST /api/ingest/fill`: `id`, `account`, `botId`, `symbol`, `side` (buy/sell), `quantity`, `price`, `fee`, `multiplier`, `time` (ISO timestamp), `reason`. Stable broker execution IDs required. Futures symbols must include contract identity/expiry; multiplier 5 for MES. Register a bot first. Source is forced to imported; reserved account `paper` is forbidden.
* `POST /api/ingest/mark`: `account`, `symbol`, `price`, `time`. Source forced to external. Cannot overwrite internal paper marks.
* `POST /api/ingest/heartbeat`: `botId`, `message`. Returns `halted`; your external process MUST enforce this itself. Terminal halt does not cancel real orders or stop external bots.

JSON file import is also available. Whole batches roll back on error. Exact duplicate fills are ignored. Imported executions are accepted during a halt because they are observed facts, not order intents. API ingestion currently requires local access; an isolated authenticated bridge is needed before remote use.

## Accounting

Average-cost net inventory is isolated by account/bot/symbol. Partial exits are closed legs, not complete round trips. Reversals close old exposure before opening new exposure. Fees are charged on execution to realized cash P&L; entry fees are proportionally allocated to closed-leg metrics. Realized equity curves start at configured paper capital; imported accounts start at zero and are **P&L curves, not broker NAV**. All daily aggregation uses UTC. Missing marks produce UNKNOWN equity/unrealized; marks older than 60 seconds are flagged stale. There is no FX/quote-currency conversion, deposit accounting, futures margin accounting or funding model. Do not combine accounts/currencies. Drawdown uses realized cash equity, not full marked-to-market historical equity.

## Risk and limitations

Legacy paper risk settings apply only to the regression engine, not Lighter. Production synthetic orders, including reducing orders, are disabled. The internal central risk foundation uses integer micro-units, transactional aggregate reservations, a 20x ceiling and a durable 6% cash-flow-adjusted UTC loss latch. It has no venue adapter or HTTP mutation interface; it is not a functioning execution control. See PREREQUISITES.md for missing evidence and reconciliation requirements.

No order submission, IBKR adapter, Nautilus execution service, perpetual accounting, candle history, or browser E2E guarantee is claimed. Markets graphs show public Lighter observations since startup; imported positions use provider/manual mark observations.