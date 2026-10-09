# A Bot and a Dream

A sci-fi-inspired, local-first trading research and paper-control terminal. **Not a live trading system. No brokerage adapter or credentials are present.**

## Run

Install [Bun](https://bun.sh) (tested with 1.4.2), then from this project directory:

```sh
bun install --frozen-lockfile
bun run check
bun start
```

Open **http://127.0.0.1:3000**. `bun run check` runs TypeScript checking, unit/integration tests and the production frontend build. After frontend changes, rebuild with `bun run build`; restart the server for backend changes. `bun run dev` starts the same local server and serves the last production build; it is not an HMR server. Override `PORT` if needed.

For the full check plus isolated production HTTP/static-asset smoke test, run `bun run scripts/verify.ts`. This writes an ignored `validation.log` with command results. Browser visual/E2E verification is not included in this release.

## Included

- Responsive React mission-control interface with six workspaces.
- ATLAS futures profile (MES) and ORION crypto profile (BTC-USD spot research).
- Persistent paper runner state, explicit start/pause, emergency halt and confirmed reset.
- Deterministic long-only channel-breakout research engine; next-open entries, fees, slippage, stop gaps, integer futures sizing and conservative unlevered notional limits.
- User-uploaded OHLC JSON or prominently labeled synthetic data.
- Research equity, drawdown, net trade journal, experiment comparison by selection and JSON export.
- Immutable saved run evidence and SHA-256 strategy registration, idempotently paper-only.
- SQLite WAL persistence, local audit trail, restart-to-paused behavior.
- Same-origin JSON mutations, host validation, loopback-only listening, CSP and no third-party frontend requests.
- Tests covering accounting, no-look-ahead prefix behavior, invalid data, stop gaps, persistence, halt, registry and HTTP workflows. GitHub Actions CI included.

**Enabling a paper runner changes its lifecycle state only. It waits for an adapter; it does not stream synthetic trades or pretend to execute.** Research registration does not attach a strategy to a running bot. Crypto perpetuals are not modeled or enabled.

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
- No broker is connected, so halt does **not** claim to cancel or flatten real orders.
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