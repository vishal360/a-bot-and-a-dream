/** Funding-semantics verifier (docs/DATA_ENGINE.md): what does Lighter's funding
 *  ACTUALLY do, according to our own recordings? Reads every archived capture's
 *  market_stats frames (funding_rate + funding_timestamp + clamps), infers the real
 *  cadence per market, and reports it against the assumption our simulators make.
 *  This closes research item #5: funding-carry screens are only honest when the
 *  funding mechanics they assume are the mechanics the venue actually runs.
 *
 *  Usage:
 *    bun run scripts/verify-funding-semantics.ts [--archive data/archive] [--out research/funding-semantics.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inferFundingCadence, type FundingSample } from '../src/funding-analysis';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const archiveRoot = resolve(arg('archive', 'data/archive'));
const outPath = resolve(arg('out', 'research/funding-semantics.json'));

if (!existsSync(archiveRoot)) throw new Error(`archive root not found: ${archiveRoot}`);
const dayDirs = readdirSync(archiveRoot, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map(d => d.name).sort();
if (!dayDirs.length) throw new Error('no UTC day folders in the archive yet');

const perMarket = new Map<string, { samples: FundingSample[]; days: Set<string> }>();
let capturesRead = 0, capturesSkipped = 0;

for (const day of dayDirs) {
  const dayDir = join(archiveRoot, day);
  const files = readdirSync(dayDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const capture = JSON.parse(readFileSync(join(dayDir, file), 'utf8'));
      const markets: { symbol?: string; market_id?: number }[] = capture?.manifest?.markets ?? [];
      const idToSymbol = new Map<number, string>();
      for (const m of markets) if (typeof m.market_id === 'number' && m.symbol) idToSymbol.set(m.market_id, m.symbol);
      for (const frame of capture?.frames ?? []) {
        let msg: any;
        try { msg = JSON.parse(frame.raw); } catch { continue; }
        const channel: string = typeof msg?.channel === 'string' ? msg.channel : '';
        if (!channel.startsWith('market_stats:')) continue;
        const stats = msg.market_stats;
        if (!stats) continue;
        const marketId = Number(channel.split(':')[1]);
        const symbol = idToSymbol.get(marketId) ?? `market-${marketId}`;
        const rate = Number(stats.funding_rate);
        if (!Number.isFinite(rate)) continue;
        const stamp = Number(stats.funding_timestamp);
        const entry = perMarket.get(symbol) ?? { samples: [], days: new Set<string>() };
        entry.samples.push({ t: Number(frame.clock?.wall ?? 0), rate, fundingTimestamp: Number.isFinite(stamp) ? stamp : null });
        entry.days.add(day);
        perMarket.set(symbol, entry);
      }
      capturesRead++;
    } catch { capturesSkipped++; }
  }
}

const markets: Record<string, unknown> = {};
for (const [symbol, { samples, days }] of [...perMarket.entries()].sort()) {
  const cadence = inferFundingCadence(samples);
  markets[symbol] = {
    ...cadence,
    daysObserved: [...days].sort(),
    firstSample: new Date(Math.min(...samples.map(s => s.t))).toISOString(),
    lastSample: new Date(Math.max(...samples.map(s => s.t))).toISOString(),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  archiveRoot, capturesRead, capturesSkipped, dayFolders: dayDirs,
  note: 'Observed funding semantics from OUR OWN captures. funding_timestamp-derived cadences are authoritative (the venue\'s schedule); rate-change-derived ones are an upper-bound inference and marked as such. This report never promotes anything.',
  markets,
};
writeFileSync(outPath, JSON.stringify(report, null, 1) + '\n');
console.log(`funding semantics written: ${outPath} (${capturesRead} captures, ${Object.keys(markets).length} market(s))`);
for (const [symbol, info] of Object.entries(markets) as [string, any][]) {
  console.log(`${symbol}: cadence ~${info.inferredCadenceHours ?? '?'}h (${info.authoritative ? 'authoritative funding_timestamps' : 'INFERRED from rate changes'}), ${info.distinctRates} distinct rate(s), ${info.changes} changes over ${info.daysObserved.length} day(s)`);
}
