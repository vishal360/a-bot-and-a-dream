import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runFeedDrills } from './lighter-feed-drills';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: bun run scripts/drill-lighter-feed.ts\nIsolated BTC/ETH fixture and local WebSocket recovery drills. No mainnet traffic, orders or operator database.\nEvidence under data/feed-drills/<uuid>/report.json. A pass never grants sustained-feed acceptance or automation authority.');
} else {
  if (args.length) throw new Error('Invalid arguments; use --help');
  const parent = new URL('../data/feed-drills/', import.meta.url);
  mkdirSync(parent, { recursive: true });
  const directory = new URL(`${crypto.randomUUID()}/`, parent);
  const report = await runFeedDrills(directory);
  console.log(`${report.passed ? 'DRILLS PASS' : 'DRILLS FAIL'}; sustained feed accepted=false; automation authorized=false\n${fileURLToPath(new URL('report.json', directory))}`);
  for (const result of report.results.filter(r => !r.passed)) console.error(`${result.name}: ${result.error ?? result.checks.filter(c => !c.passed).map(c => c.name).join('; ')}`);
  process.exitCode = report.passed ? 0 : 1;
}