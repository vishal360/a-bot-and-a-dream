# Current paper simulation status

Manual BTC mainnet-depth simulation is now available in Command center and Executions.
It uses a separate $10,000 simulated account, long-only at 1×, with explicit activation
and aggregate allocation above 0%. It does not place venue orders or run agents.
This is an interim REST-depth price simulator, not complete perpetual execution.
See [assessment, limits and required inputs](docs/ASSESSMENT.md).

# A Bot and a Dream

A sci-fi-inspired, local-first trading terminal with public Lighter market/account reads, a historical ledger, account-scoped analytics, encrypted credentials, read-only broker synchronization and authenticated external-bot ingestion. **Not an order execution system. Synthetic production execution is disabled.**

See [Operations guide](docs/OPERATIONS.md) for connection setup, accounting semantics, bot ingestion contracts and important limitations.

## Run

Install [Bun](https://bun.sh) (tested with 1.4.2), then from this project directory:

```sh
bun install --frozen-lockfile
bun run check
bun start
```

Open **http://127.0.0.1:3000**. `bun run check` runs TypeScript checking, unit/integration tests and the production frontend build. After frontend changes, rebuild with `bun run build`; restart the server for backend changes. `bun run dev` starts the same local server and serves the last production build; it is not an HMR server. Override `PORT` if needed.

For the full check plus isolated production HTTP/static-asset smoke test, run `bun run scripts/verify.ts`. This writes an ignored `validation.log` with command results.

Run `bun run test:e2e` for Playwright acceptance tests using installed Microsoft Edge.
The suite covers desktop and mobile-sized Chromium viewports with deterministic depth,
real backend routes, isolated temporary SQLite state, and no actual venue requests.
It verifies activation, allocation rejection, partial fills, accounting, refresh,
restart-paused recovery and halted position closure. Mobile viewport testing is not
verification on a physical phone or Safari. Screenshots and failure traces are saved
under `test-results/`; the HTML report is under `playwright-report/`.

## Included

- Responsive React interface with ten workspaces, equity/price/drawdown graphs, daily P&L, best/worst trades and runner rankings.
- Legacy synthetic strategy and risk engine retained for regression tests only; production order/flatten/start routes reject requests.
- Persistent portfolio allocation preview using current public venue equity; internal shared risk/reservation foundation (not venue-connected).
- AES-256-GCM credential vault; Alpaca paper/live and Binance spot read-only synchronization.
- Authenticated external-bot fill/mark/heartbeat ingestion, token rotation, deduplication, JSON import/export and alerts.
- ATLAS futures profile (MES) and ORION crypto profile (BTC-USD spot research).
- Persistent runner state, pause, emergency halt and confirmed reset; production starts remain disabled.
- Deterministic long-only channel-breakout research engine; next-open entries, fees, slippage, stop gaps, integer futures sizing and conservative unlevered notional limits.
- User-uploaded OHLC JSON or prominently labeled synthetic data.
- Research equity, drawdown, net trade journal, experiment comparison by selection and JSON export.
- Immutable saved run evidence and SHA-256 strategy registration, idempotently paper-only.
- SQLite WAL persistence, local audit trail, restart-to-paused behavior.
- Same-origin JSON mutations, host validation, loopback-only listening, CSP and no third-party frontend requests.
- Tests covering accounting, no-look-ahead prefix behavior, invalid data, stop gaps, persistence, halt, registry and HTTP workflows. GitHub Actions CI included.

**Production runner starts and synthetic orders/flattening are disabled.** Legacy synthetic history is retained, not advanced as venue data. Research registration does not deploy a strategy. Public Lighter reads do not prove signer authentication. See [Lighter status](docs/LIGHTER.md) and [acceptance gates](docs/PREREQUISITES.md).

## Data format

Upload a JSON array of 30–100,000 positive, valid OHLC bars in strictly increasing timestamp order (10 MB frontend upload limit):

```json
[
  {"time":"2025-01-01T00:00:00Z","open":100,"high":102,"low":99,"close":101}
]
```

The example illustrates the schema, not a sufficient dataset. Data is labeled **user-uploaded / unverified**: the application cannot certify its provenance. Input has no volume, spread, session, funding or roll metadata. Do not interpret results as execution-realistic MES or perpetual-futures backtests.

## Research assumptions

Completed bar close breaks the previous N highs → next bar open entry. Exit on fixed stop, completed-bar lower-channel break at next open, or final close. A stop gap fills at the worse of stop and open, then applies adverse slippage. The futures research multiplier is 5; prices are not tick-rounded. Fees are generic basis points, **not a calibrated broker fee schedule**. Entry risk includes estimated costs, but gaps can exceed that risk. Notional is capped at capital; exchange margin/leverage is deliberately absent.

Equity marks open positions to close, after charged entry fees but without hypothetical exit costs until exit. Drawdown is peak-to-trough research equity. Trade P&L includes both fees. Profit factor is gross winning net trade P&L divided by absolute losing net trade P&L; undefined with no losses. These are in-sample experiments: **no automatic statistical validation, walk-forward certification or profitability assurance** is provided.

## Safety and operation

Keep this service local. There is no multi-user authentication. Do not reverse-proxy it publicly, change bind behavior, or expose it through a tunnel. Same-origin controls are not a substitute for authentication. Local administrator/software access can modify the database and audit trail.

- Emergency halt is transactionally persisted and blocks starts.
- Reset requires `RESET`, clears the latch and leaves both runners paused.
- Restart never resumes a runner automatically.
- Read-only broker connections and external bots are not controlled by halt; it does **not** cancel or flatten real orders. Legacy positions remain recorded; disabled flatten routes cannot close them.
- Data is in `data/terminal.sqlite` and WAL sidecars. Stop the server before copying the entire `data` directory for backup. Restore while stopped; reopen and verify audit, registry and halt state.
- Do not commit data, credentials, uploaded datasets or `.env`; these are ignored.

## Architecture and next integration boundary

See [architecture](docs/ARCHITECTURE.md) and [live-readiness requirements](docs/LIVE_READINESS.md). This repository is the runnable first vertical slice, not an implementation of all previously discussed broker, research or AI capabilities. TypeScript/Bun was selected because Bun is installed on the initial machine; Python/NautilusTrader belongs in a separate execution service. No AI model is authorized to submit orders or modify live strategy code.

## GitHub publishing

Recommended repository slug: `a-bot-and-a-dream`, description/display name: **A Bot and a Dream**. Default to private until reviewed. With authenticated GitHub CLI:

```sh
gh repo create a-bot-and-a-dream --private --source=. --remote=origin --push
```

No project license has been chosen. Do not assume permission to redistribute third-party code; none of the supplied trading repositories is vendored here.