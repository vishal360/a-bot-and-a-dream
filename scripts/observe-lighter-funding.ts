import { mkdirSync } from 'node:fs';
import { lighterHosts } from '../src/lighter';
import { units } from '../src/paper-math';

// Public observation only. No operator DB, account authentication, paper fills or flags.
const directory = new URL(`../data/funding-evidence/${crypto.randomUUID()}/`, import.meta.url);
mkdirSync(directory, { recursive: true });
const hash = (v: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(v)).digest('hex');
const samples: { symbol: string; marketId: number; observedAt: string; source: string; sha256: string; body: any }[] = [];
let error: string | null = null;
try {
  const get = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Public funding evidence HTTP ${response.status}`);
    return response.json();
  };
  const metadata = await get(`${lighterHosts.mainnet}/api/v1/orderBookDetails`);
  if (metadata.code !== 200 || !Array.isArray(metadata.order_book_details)) throw new Error('Invalid metadata');
  await Bun.write(new URL('metadata.json', directory), JSON.stringify(metadata));
  const end = Math.floor(Date.now() / 3600000) * 3600;
  for (let round = 0; round < 2; round++) {
    if (round) await Bun.sleep(2000);
    for (const symbol of ['BTC', 'ETH']) {
      const matches = metadata.order_book_details.filter((m: any) => m.symbol === symbol && m.status === 'active' && m.market_type === 'perp');
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].market_id)) throw new Error('Unique market identity required');
      const marketId = matches[0].market_id;
      const source = `${lighterHosts.mainnet}/api/v1/fundings?market_id=${marketId}&resolution=1h&start_timestamp=${end - 6 * 3600}&end_timestamp=${end}&count_back=0`;
      const body = await get(source);
      if (body.code !== 200 || body.resolution !== '1h' || !Array.isArray(body.fundings) || !body.fundings.length) throw new Error('Funding evidence unavailable');
      const times = new Set<number>();
      for (const row of body.fundings) {
        if (!Number.isSafeInteger(row.timestamp) || row.timestamp % 3600 || times.has(row.timestamp) || !['long', 'short'].includes(row.direction)) throw new Error('Invalid hourly funding identity');
        units(row.value, 8); units(row.rate, 8); times.add(row.timestamp);
      }
      samples.push({ symbol, marketId, observedAt: new Date().toISOString(), source, sha256: hash(body), body });
    }
  }
} catch (e) { error = (e as Error).message; }
const report = { version: 1, source: 'public Lighter mainnet funding history', complete: error === null, samples,
  unchangedDuringSample: error === null && ['BTC', 'ETH'].every(symbol => {
    const s = samples.filter(s => s.symbol === symbol); return s.length === 2 && s[0].sha256 === s[1].sha256;
  }), error, eligibilityVerified: false, boundaryOrderingVerified: false, finalityVerified: false, automationAuthorized: false, executionEnabled: false };
await Bun.write(new URL('report.json', directory), JSON.stringify(report, null, 2));
console.log(new URL('report.json', directory).pathname);
console.log(JSON.stringify({ complete: report.complete, unchangedDuringSample: report.unchangedDuringSample, finalityVerified: false, error }));
process.exitCode = error ? 1 : 0;