import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lighterHosts } from '../src/lighter';
import { compareFundingEvidence, positionFundingRows, publicFundingRows, type PositionFundingRow, type PublicFundingRow } from './lighter-funding-evidence';

// GET-only public-pool evidence. No credentials, operator database or trading imports.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: bun run scripts/corroborate-lighter-funding.ts\nBounded public protocol-pool BTC/ETH funding evidence; no credentials or orders.\nSample arithmetic can corroborate a candidate interpretation, never eligibility, ordering or finality.');
} else {
  if (args.length) throw new Error('No account/authentication arguments accepted; use --help');
  const directory = new URL(`../data/funding-evidence/${crypto.randomUUID()}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const artifacts: { file: string; source: string; requestedAt: string; observedAt: string; status: number; sha256: string; bytes: number }[] = [];
  const markets: { symbol: string; marketId: number }[] = [];
  const rows: PositionFundingRow[] = [], histories = new Map<number, PublicFundingRow[]>();
  let pool: { accountIndex: number; name: string; accountType: number } | null = null;
  let error: string | null = null, truncated = false, snapshot: any = null, tradeRows = 0, tradesTruncated = false;
  const get = async (source: string, file: string, json = true): Promise<any> => {
    const requestedAt = new Date().toISOString();
    const response = await fetch(source, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Evidence response too large');
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Evidence response too large'); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks);
    await Bun.write(new URL(file, directory), raw);
    artifacts.push({ file, source, requestedAt, observedAt: new Date().toISOString(), status: response.status,
      sha256: new Bun.CryptoHasher('sha256').update(raw).digest('hex'), bytes });
    if (!response.ok) throw new Error(`Public evidence HTTP ${response.status}`);
    return json ? JSON.parse(raw.toString('utf8')) : null;
  };
  try {
    for (const [name, source] of [
      ['funding', 'https://docs.lighter.xyz/trading/funding.md'],
      ['fundings', 'https://apidocs.lighter.xyz/reference/fundings.md'],
      ['positionfunding', 'https://apidocs.lighter.xyz/reference/positionfunding.md'],
      ['publicpoolsmetadata', 'https://apidocs.lighter.xyz/reference/publicpoolsmetadata.md'],
      ['trades', 'https://apidocs.lighter.xyz/reference/trades.md'],
      ['timestamps', 'https://apidocs.lighter.xyz/docs/timestamps.md'],
    ]) await get(source, `official-${name}.md`, false);
    const metadata = await get(`${lighterHosts.mainnet}/api/v1/orderBookDetails`, 'metadata.json');
    if (metadata?.code !== 200 || !Array.isArray(metadata.order_book_details)) throw new Error('Invalid market metadata');
    for (const symbol of ['BTC', 'ETH']) {
      const matches = metadata.order_book_details.filter((m: any) => m.symbol === symbol && m.status === 'active' && m.market_type === 'perp');
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].market_id) || matches[0].market_id < 0) throw new Error('Unique market identity required');
      markets.push({ symbol, marketId: matches[0].market_id });
    }
    if (new Set(markets.map(m => m.marketId)).size !== 2) throw new Error('Duplicate market identity');
    const pools = await get(`${lighterHosts.mainnet}/api/v1/publicPoolsMetadata?index=${Number.MAX_SAFE_INTEGER}&limit=5&filter=protocol`, 'pools.json');
    if (pools?.code !== 200 || !Array.isArray(pools.public_pools) || pools.public_pools.length > 5) throw new Error('Invalid public pool discovery');
    const p = pools.public_pools[0];
    if (!p || !Number.isSafeInteger(p.account_index) || p.account_index < 0 || typeof p.name !== 'string' || !Number.isSafeInteger(p.account_type)) throw new Error('Public protocol pool unavailable');
    pool = { accountIndex: p.account_index, name: p.name, accountType: p.account_type };
    const account = await get(`${lighterHosts.mainnet}/api/v1/account?by=index&value=${pool.accountIndex}`, 'account.json');
    snapshot = { sourceFile: 'account.json', boundarySnapshot: false, note: 'Current observation only; never a historical funding-boundary position.' };
    if (account?.code !== 200) throw new Error('Public account observation unavailable');
    const end = Math.floor(Date.now() / 3600000) * 3600, start = end - 24 * 3600;
    let cursor = ''; const cursors = new Set<string>(), fundingIds = new Set<number>(), fundingHours = new Set<string>();
    for (let page = 0; page < 2; page++) {
      const query = new URLSearchParams({ account_index: String(pool.accountIndex), limit: '50', side: 'all', market_ids: markets.map(m => m.marketId).join(','), start_timestamp: String(start), end_timestamp: String(end) });
      if (cursor) query.set('cursor', cursor);
      const body = await get(`${lighterHosts.mainnet}/api/v1/positionFunding?${query}`, `position-funding-${page}.json`);
      for (const row of positionFundingRows(body, markets.map(m => m.marketId))) {
        const key = `${row.market_id}:${row.timestamp}`;
        if (row.timestamp < start || row.timestamp > end || fundingIds.has(row.funding_id) || fundingHours.has(key)) throw new Error('Out-of-window or overlapping account funding pages');
        rows.push(row); fundingIds.add(row.funding_id); fundingHours.add(key);
      }
      cursor = body.next_cursor ?? '';
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('Repeated account funding cursor');
      cursors.add(cursor); truncated = page === 1;
    }
    if (!rows.length) throw new Error('No account funding rows observed');
    for (const market of markets) {
      const query = new URLSearchParams({ market_id: String(market.marketId), resolution: '1h', start_timestamp: String(start - 3600), end_timestamp: String(end + 3600), count_back: '0' });
      const body = await get(`${lighterHosts.mainnet}/api/v1/fundings?${query}`, `history-${market.symbol}.json`);
      histories.set(market.marketId, publicFundingRows(body));
    }
    // A bounded recent fill page aids later manual inspection, not boundary reconstruction.
    const query = new URLSearchParams({ account_index: String(pool.accountIndex), market_type: 'perp', sort_by: 'timestamp', sort_dir: 'desc', limit: '100', aggregate: 'false' });
    const trades = await get(`${lighterHosts.mainnet}/api/v1/trades?${query}`, 'recent-trades.json');
    if (trades?.code !== 200 || !Array.isArray(trades.trades) || trades.trades.length > 100 || trades.trades.some((t: any) => t.ask_account_id !== pool!.accountIndex && t.bid_account_id !== pool!.accountIndex)) throw new Error('Invalid public pool trades');
    tradeRows = trades.trades.length; tradesTruncated = !!trades.next_cursor;
  } catch (e) { error = (e as Error).message; }
  const comparisons = compareFundingEvidence(rows, histories);
  const report = { version: 1, source: 'public Lighter protocol-pool corroboration', startedAt, endedAt: new Date().toISOString(), complete: error === null,
    pool, markets, artifacts, snapshot, positionFundingRows: rows.length, fundingPaginationTruncated: truncated, recentTradeRows: tradeRows, tradesTruncated, comparisons,
    candidatePolicy: 'Equal timestamp labels only. Public value treated as quote per base unit; direction treated as payer. Signed account rate * 100 compared to signed public rate. Tolerance: 1 micro quote unit + position size * 1e-8. These are hypotheses, not venue contracts.',
    limitations: ['Public pool only, not operator-account or fee-tier conformance', 'Current snapshot and bounded recent trades cannot reconstruct boundary holdings',
      'No funding transaction sequence/hash linkage or finality contract', 'Discount and venue rounding semantics unverified', 'Local wall clock is not certified'],
    error, eligibilityVerified: false, boundaryOrderingVerified: false, publicUnitsContractVerified: false, roundingVerified: false, finalityVerified: false,
    overnightMarksVerified: false, automationAuthorized: false, executionEnabled: false };
  await Bun.write(new URL('report.json', directory), JSON.stringify(report, null, 2));
  console.log(fileURLToPath(new URL('report.json', directory)));
  console.log(JSON.stringify({ complete: report.complete, rows: rows.length, candidateConsistent: comparisons.filter(c => c.status === 'candidate-consistent').length,
    missingPublicHours: comparisons.filter(c => c.status === 'public-hour-unavailable').length, finalityVerified: false, error }));
  process.exitCode = error ? 1 : 0;
}