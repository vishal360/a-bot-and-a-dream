# Project Roadmap — living status board

Updated: 2026-10-28. This is the operator-facing tracker: what is done, what is
in progress, what is parked and why, and what was deliberately removed. The
evidence-gate detail behind "done" claims lives in [AUTOMATION_ROADMAP.md](AUTOMATION_ROADMAP.md);
strategy semantics live in [FLEET.md](FLEET.md). Update this file every increment.

Goal: a local-first automated trading terminal — multiple bots on multiple
assets, a hedge-fund-grade dashboard, an honest research pipeline, an AI agent
layer with a hard risk authority — with live execution as a separate, still-locked
future project.

## Done

| Item | Where | Notes |
|---|---|---|
| Manual paper terminal (signed perpetual accounting, IOC, protections) | src/paper*.ts | Shipped; 24h-tested feed machinery |
| Multi-bot fleet runner (caps, cooldowns, daily-loss stop, one net direction per market) | src/fleet.ts | 253 tests green |
| Strategy registry with frozen artifact hashes | src/strategies/ | breakout-v1, mean-reversion-v1, funding-carry-v1 |
| Feed-health guard (dwell, rolling 99%, integrity latch) | src/feed-health.ts | Fail-closed; closes never blocked |
| Decision journal with per-decision risk checks | src/journal.ts | Bounded 5k rows; API + UI |
| Hedge-fund fleet dashboard | src/web/FleetConsole.tsx | Live-verified screenshot; KPI glow, guard pulse |
| No-look-ahead replay backtester | src/backtest-replay.ts | Next-book top-of-book fills |
| Strict acceptance clock (loosened tolerance removed) | scripts/lighter-acceptance-clock.ts | Matches declared 2s policy |
| Word operations guide (living deliverable) | Documents/A Bot and a Dream - Terminal Guide.docx | Regenerate per increment |
| **Research lane v1: SPA/StepM multiplicity gate** | research/spa_verify.py | arch-backed; self-tested (noise→no edge, edge→p=0.0) |
| **Research lane v2: SPA verdicts wired into strategy promotion** | src/promotion.ts + scripts/research-promote.ts | Fleet gate ratchets to strict on the first PASS manifest (research/promotions.json); FAIL verdicts install nothing |

## In progress

| Item | Status | Next action |
|---|---|---|
| 24h sustained feed acceptance | FAILED on desktop host (97.64% < 99%); pipeline clean (0 gaps, 0 recording failures) | Run once on a cloud VM per [CLOUD_ACCEPTANCE.md](CLOUD_ACCEPTANCE.md); do not assume, verify |
| Agent layer | Design locked (sub-account, one-direction rule, proposal contracts, shadow-first) | Needs operator Gemini key per [AGENT_SETUP.md](AGENT_SETUP.md); build order: sub-account → proposal contracts → shadow mode |

## Next up (ordered)

1. Agent sub-account accounting on the paper ledger.
2. Proposal contracts (expiry, confidence, ensemble 2-of-3; MAPIE conformal intervals feed the confidence width) + shadow mode journaling.
3. Alerting: push halt/decision events to Telegram or email (the journal records; nothing pushes yet).
4. Per-bot equity sparklines on the fleet dashboard.
5. Automated off-machine backup of `data/terminal.sqlite`.
6. Playwright end-to-end coverage of fleet flows.

## Parked (with reasons — revisit, do not delete)

| Item | Why parked | Revisit when |
|---|---|---|
| PySR (symbolic regression) | Data-hungry; Julia/Python runtime weight | Months of retained market data exist |
| tick (Hawkes order flow) | Captures are 2k-frame prefixes; orders of magnitude too little data | Durable archive accumulates real depth history |
| NautilusTrader execution service | Live trading is a separate locked project | After live gate opens |

## Removed

- Loosened acceptance-clock tolerance (post-sync dispersion spikes above the 2s policy) — removed 2026-10-27; strict fail-closed restored.
- Cline scratch artifacts (`list-cloud*.mjs`, `_*.txt` console dumps, stray `test-*.ts`) — deleted 2026-10-27; they broke the review-bundle verifier.
- Legacy "Bot fleet" placeholder cards on the dashboard — replaced by the real fleet console on 2026-10-27.

## Deliberately kept (not removed)

The legacy synthetic ATLAS/ORION runner definitions remain in the code, disabled
and test-covered: they are regression fixtures for the research/ledger path and
removing them buys nothing today. Re-evaluate if they ever cost more than they
hold.
