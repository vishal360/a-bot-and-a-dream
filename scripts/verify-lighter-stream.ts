// Optional bounded public-data probe. No terminal process or operator database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { LighterStream } from '../src/lighter-stream';
import { lighterHosts } from '../src/lighter';

const dir = mkdtempSync(join(tmpdir(), 'dream-stream-probe-'));
const store = new Store(join(dir, 'probe.sqlite')), stream = new LighterStream(store, { marketStats: true });
let passed = false, error: string | null = null;
const started = new Date().toISOString();
try {
  const response = await fetch(lighterHosts.mainnet + '/api/v1/orderBookDetails', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 200 || !Array.isArray(body.order_book_details)) throw new Error('Invalid venue metadata');
  const markets = body.order_book_details.filter((m: any) => ['BTC', 'ETH'].includes(m.symbol) && m.status === 'active');
  if (markets.length !== 2) throw new Error('BTC/ETH active perpetual metadata required');
  stream.watch(markets.map((m: any) => ({ symbol: m.symbol, market_id: m.market_id, supported_price_decimals: m.supported_price_decimals, supported_size_decimals: m.supported_size_decimals })));
  stream.start();
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    await Bun.sleep(100);
    const status = stream.status();
    if (status.state === 'recording failed') throw new Error(status.error ?? 'Recording failed');
  }
  const status = stream.status();
  passed = status.healthy && status.counts.accepted >= 20 && status.counts.gaps === 0 && status.counts.invalid === 0 && status.counts.disconnects === 0;
  if (!passed) throw new Error('Probe needs healthy BTC/ETH depth AND market stats, at least 20 validated frames and no gaps/errors/disconnects over 20 seconds');
} catch (e) { error = (e as Error).message; }
finally {
  const status = stream.status(); stream.stop();
  const records = store.db.query('SELECT kind,COUNT(*) AS count FROM lighter_feed_journal GROUP BY kind').all();
  await Bun.write(new URL('../lighter-stream-probe.log', import.meta.url), JSON.stringify({ started, completed: new Date().toISOString(), result: passed ? 'PASS' : 'FAIL', exit: passed ? 0 : 1, error, status, records }, null, 2));
  store.db.close(); rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed ? 'PASS' : 'FAIL'}: read-only Lighter BTC/ETH stream probe; see lighter-stream-probe.log`);
process.exitCode = passed ? 0 : 1;