# Isolated Lighter feed recovery drills

This is an engineering failure/recovery suite, **not** mainnet acceptance, a venue
guarantee, strategy validation or permission to run autonomous orders. No production
health threshold, execution route or readiness flag is changed by these drills.

From `C:/Users/Awperation/.cline/data/workspaces/chat/trading-terminal`:

```powershell
bun run scripts/drill-lighter-feed.ts
bun test tests/lighter-feed-drills.test.ts
```

The runner creates a new `data/feed-drills/<uuid>/` directory, with isolated SQLite
databases, capture exports, failed acceptance examples and a flushed, atomically
published `report.json`. It exercises the production `LighterStream`, evidence/replay,
acceptance evaluator, patched observation loop and heartbeat publisher. BTC/ETH
identities, prices and clocks are explicitly fixtures, never fetched mainnet evidence.
The only network endpoint is an ephemeral `127.0.0.1` WebSocket owned by the suite.
It closes its own feeds, transports and databases; it does not touch an existing
observer, terminal process, operator database, credentials, accounts or Paper module.
Unknown options (including live/account/duration switches) are rejected.

## Predeclared checks

1. **Disconnect/resnapshot:** immediately withdraw executable depth; reject stale
   callbacks from the prior epoch; require complete roots and fresh stats for overall
   feed health. A disconnect between healthy samples still counts as unhealthy.
2. **Sequence gap:** reject and durably mark the bad delta, invalidate execution,
   reconnect with fresh roots, and replay only accepted prefixes.
3. **Stale stats:** fresh book updates cannot hide expired market stats; reconnect
   still requires new snapshot/stats evidence. No tolerance widening.
4. **Future publication:** reject publication more than two seconds ahead of the
   fixture host clock. Recovery uses valid timestamps, never an applied offset.
5. **Recording failure:** SQLite write refusal invalidates all executable depth,
   latches the instance off and propagates through the patched observer. A repaired
   database alone cannot restart the fatal instance or qualify a partial observation.
6. **Connect-recording failure:** a failed connect journal write must prevent any
   transport construction and cannot enter an automatic retry loop.
7. **Restart/restore:** preserve an interrupted capture, reopen both its original
   closed database and a closed-database copy, replay retained roots, but inherit no
   executable depth. A new connection must establish a new epoch with fresh roots.
8. **Slow heartbeat:** a deterministic simulated stall crossing the observation
   deadline still needs a final sample; the 3.001-second gap fails unchanged health
   policy. The durable completed lifecycle reports **failed** acceptance.
9. **Real loopback disconnect:** exercise actual local WebSocket subscription,
   disconnection, resubscription and replay for both epochs across all six channels.

Each check retains its observed values; failures make the suite exit nonzero. The
report includes byte counts and SHA-256 hashes for retained artifacts and relevant
source files, plus Bun/platform information. Missing/incomplete reports are not
passes. Local hashes detect modification; they are not independent attestations.
The report always sets sustained-feed acceptance, strategy validation, automation,
agents, execution and signing to false, including when every drill passes.

## Limits and the next sustained run

- SQLite `query_only` refusal is a deterministic storage fault, **not** a physical
  full-disk, permission, power-loss or controller-durability certification.
- Leaving an interrupted manifest simulates unclean shutdown state; it does not
  certify OS process-kill handling. Restore copies a **closed** isolated database,
  not an online operator backup or account reconciliation.
- Most timing uses fixture clocks; the heartbeat stall is simulated, not a claim
  about actual filesystem performance. Loopback has real transport but no venue data.
- Neither the suite nor the older, already-running observer proves 24-hour health
  under the patched loop. Public trade continuity remains unproven.

Leave the existing observer untouched. Review its final report when available,
retaining failures rather than retroactively labeling it patched. After reviewing
host-clock health, start a **separate** patched short sample before a separate
24-hour read-only run using the roadmap commands. Archive source versions/hashes
before launch and identify the new run by its UUID/PID and `run.json`; only its
durable final report and replay exports can be reviewed as acceptance evidence.
Do not infer completion from wall time, a heartbeat or a passing fixture suite.

Funding boundary ordering, eligibility, units, rounding, finality and overnight UTC
marks remain separate unresolved evidence gates. No drill changes them.