# Stage 3: deterministic research strategies

These four direction-only strategies are **research-only**, not enabled trading agents. No profitability claims, fitted parameter selection, backtest selection or promotion eligibility are implied. They do not execute orders, size positions, access credentials, call the network, depend on funding, or consume volume. Parent integration must preserve research-only gating and existing execution/risk caps.

## Exports and integration metadata

`src/strategies/research.ts` exports:

| Export | Stable ID | Meaning |
| --- | --- | --- |
| `channelTrendResearchV1` | `research-channel-trend-v1` | Completed close breaks prior completed-minute observed-mid high/low channel |
| `zscoreReversionResearchV1` | `research-zscore-reversion-v1` | Fade completed close's z-score relative to prior closes when endpoint drift is small |
| `pullbackContinuationResearchV1` | `research-ma-pullback-v1` | Fast/slow moving-average alignment, fast-mean pullback touch, then continuation close |
| `squeezeExpansionResearchV1` | `research-squeeze-expansion-v1` | Prior ranges contract, then a completed bar expands and closes outside squeeze channel |
| `researchStrategies` | — | These four strategy objects only; not automatically registered |
| `completedResearchBars` | — | Pure bounded completed-minute feature helper |
| `RESEARCH_VERSION` | `completed-minute-v1` | Helper/feature interpretation version |

Each object has `researchOnly: true` and `artifactSources: ['src/strategies/research.ts', 'src/strategies/types.ts']`. A local `ResearchStrategy` intersection preserves these fields before the parent adds optional `Strategy.researchOnly` and `Strategy.artifactSources`. Parent should register the exports explicitly, retain the flag across registry/persistence/API boundaries, deny automatic fleet enablement/promotion, and hash all declared source artifacts plus resolved params when establishing research identity. Changes to the helper invalidate all four identities. No builtin, registry or fleet changes are made here.

Open proposals contain only `action`, `side`, `rationale`; close proposals always close fraction 1. There is no `riskFraction`, sizing, pyramiding, averaging-down, martingale, shared mutable evaluation state, or time stop. No `openedAt` type addition is needed. Parent position sizing must enforce its risk caps; the bounded `stopPct` parameter is not itself a guaranteed execution price or risk limit.

## Causal observed-mid minute bars

The input contract remains the existing `StrategyContext`: oldest-first one-second mid samples, maximum 3600 points in a rolling one-hour context. Oversized contexts are rejected, not truncated into apparently valid history. Invalid timestamps, non-finite/nonpositive prices, duplicate or unordered timestamps, and **any future point** cause feature rejection. Points older than one hour are excluded. Current-minute points are validated but never contribute to bars; no bar with minute start at or after the current UTC minute is used.

Each bar is OHLC of observed mids, **not venue trade OHLC**. A completed minute needs at least 50 seconds elapsed from first to last observation, first and last observations within five seconds of their respective minute boundaries, and no internal interval over five seconds. Observation count alone cannot satisfy coverage. Return only the contiguous valid suffix ending at the immediately preceding minute; stale windows, missing minutes or incomplete latest minutes cannot borrow old history to warm up. With a clock 30 seconds into the current minute, a full 3600-second window can provide 59 full historical minutes; the oldest partial minute is excluded.

Every schema fits this horizon: channel and z-score need `lookbackMinutes + 1` bars (default 21, maximum 46); pullback needs `lookbackMinutes + 2` (default 22, maximum 47); squeeze needs `lookbackMinutes + squeezeMinutes + 1` (default 25, maximum 54). Features are recomputed from context on each call and do not mutate it. No wall-clock calls, randomness, trade quantities or fake/synthetic volume are used.

## Entry and exit rules

All strategies share validated bounded defaults:

| Parameter | Default | Bounds |
| --- | --- | --- |
| `stopPct` | 0.008 | 0.001–0.05 |
| `takeProfitPct` | 0.016 | 0.002–0.15 |
| `maxSpreadPct` | 0.001 | 0.00001–0.01 |
| `minVolPct` | 0.0001 | 0–0.01 |
| `maxVolPct` | 0.015 | 0.0001–0.05 |

Fractions are decimal fractions, not percentage points. Volatility is RMS of adjacent completed close simple returns across the exact required feature window; this includes the latest **completed**, never current, bar. A zero/degenerate flat window cannot trade with defaults. Inverted volatility bounds hold. Entry spreads are `(ask - bid) / midpoint`; all top quote prices must be positive finite and uncrossed. Quote timestamps must be valid, no later than `now`, and no more than ten seconds old. Missing/invalid/stale/future quotes hold, including for positions, because a trustworthy executable-side quote is absent.

For an existing valid nonzero position, protective stop and target checks happen **before history/warmup, volatility, spread and strategy filters**. Long exits use bid; short exits use ask. The strategy never opens or reverses while holding a position. Beyond protective exits it holds; signals are entry-only, not implicit mean/channel exits. Invalid parameters or invalid position metadata hold rather than inventing thresholds. Stop/target values are checked against average entry; no time stop is assumed from missing metadata.

1. **Channel trend:** compare latest completed close with high/low of the preceding `lookbackMinutes` bars, plus `breakoutBufferPct` (default 0.0002, bounds 0–0.01). Strictly above buys; strictly below sells. The signal bar is excluded from its own channel.
2. **Z-score reversion:** prior `lookbackMinutes` close mean and population standard deviation define z-score for latest completed close. Prior first-to-last absolute fractional drift must not exceed `maxTrendPct` (default 0.005, bounds 0.0001–0.03). Standard deviation must exceed mean times 1e-10. `entryZ` defaults to 2 (bounds 1–5). Negative extreme buys; positive extreme sells. Latest close is excluded from its own mean, deviation and trend filter.
3. **Moving-average pullback:** fast mean defaults to five prior closes (`fastMinutes` bounds 2–10) and must be shorter than the slow `lookbackMinutes` mean. Uptrend requires fast above slow and above its previous-bar value; pullback bar low touches fast within `pullbackPct` (default 0.001, bounds 0–0.01), its close remains above slow, and latest completed close breaks pullback high. Mirror conditions sell. Means exclude signal bar; previous fast excludes pullback too.
4. **Squeeze expansion:** average normalized high-low range over the older `lookbackMinutes` baseline is compared with the subsequent `squeezeMinutes` bars (default 4, bounds 2–8). Squeeze average must be positive and at most `squeezeRatio` (default 0.5, bounds 0.1–0.9) times positive baseline average. Latest completed true range relative to previous close must reach `expansionRatio` (default 2, bounds 1.1–5) times squeeze average; a close above squeeze high buys and below squeeze low sells. Zero ranges are not evidence of a tradable squeeze.

The shared lookback defaults to 20 and is an integer 5–45. Parameter schemas validate numeric finiteness, bounds, integers and unknown keys via existing `validateParams`; evaluate also resolves defaults defensively and holds on invalid parameters. No cross-parameter relationship is silently clamped.

## Offline verification

Run:

```powershell
& 'C:\Users\Awperation\.bun\bin\bun.exe' test ./tests/research-strategies.test.ts
```

Tests cover mirrored buy/sell signals, frozen repeated-context determinism, protective stops/targets before warmup and filters, invalid/stale/future quotes, stale/future/gappy/malformed/oversized input, flat/no-trade contexts, bounded schema validation, elapsed coverage, strict completed-minute exclusion, and strategy-specific gates. Tests use synthetic mids only to assert mechanics, not performance. No real network or fleet activation is required.
