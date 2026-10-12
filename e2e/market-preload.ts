// Loaded only by isolated test child processes. Production has no fixture switch.
import { existsSync, mkdirSync } from 'node:fs';
import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { PaperRiskDays } from '../src/paper-risk-days';
import { PaperFunding } from '../src/paper-funding';
import type { Fill } from '../src/ledger';
if (process.env.PAPER_FIXTURE_BASELINE_HALT === '1') {
  mkdirSync('data', { recursive: true });
  const store = new Store('data/terminal.sqlite'); new Operations(store, {} as any); new PaperFunding(store);
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10), start = Date.parse(`${today}T00:00:00Z`), hour = start - 3 * 3600000;
  const session = { capital: 10000, enabled: false, feeBps: 2, latencyMs: 0, createdAt: new Date(start - 2 * 86400000).toISOString() };
  store.set('paperSession', session); store.set('allocationPct', 100);
  const fills: Fill[] = ['buy', 'sell'].map((side, i) => ({ id: `baseline-fixture-${i}`, account: 'paper-mainnet', botId: 'orion', symbol: 'BTC-USD',
    side: side as 'buy' | 'sell', quantity: .001, price: 50000, fee: 0, multiplier: 1, source: 'paper', reason: 'fixture', time: new Date(hour + (i ? 600000 : -600000)).toISOString() }));
  for (const fill of fills) store.db.query('INSERT INTO fills VALUES (?,?,?,?)').run(fill.account, fill.id, fill.time, JSON.stringify(fill));
  store.db.exec('CREATE TABLE IF NOT EXISTS paper_orders(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS paper_observations(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  for (const fill of fills) {
    const observationId = `${fill.id}-observation`, market = { symbol: 'BTC', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2 };
    const observation = { id: observationId, market, bids: [{ price: fill.side === 'sell' ? 50000 : 49999, quantity: 1 }], asks: [{ price: fill.side === 'buy' ? 50000 : 50001, quantity: 1 }] };
    const order = { id: fill.id, symbol: 'BTC', side: fill.side, quantity: fill.quantity, filled: fill.quantity, canceled: 0, price: fill.price,
      status: 'filled', type: 'market', source: 'manual', time: fill.time, leverage: 1, observationId, executions: [{ price: fill.price, quantity: fill.quantity }] };
    store.db.query('INSERT INTO paper_orders VALUES (?,?)').run(order.id, JSON.stringify(order));
    store.db.query('INSERT INTO paper_observations VALUES (?,?)').run(observationId, JSON.stringify(observation));
  }
  new PaperRiskDays(store).ensure(today, null, fills, session, now - 1000, { funding: [] });
  const raw = { timestamp: hour / 1000, value: '0.5', rate: '0.001', direction: 'long' };
  const event = { version: 1, id: `1:${raw.timestamp}`, symbol: 'BTC-USD', marketId: 1, timestamp: raw.timestamp, time: new Date(hour).toISOString(),
    rate: raw.rate, direction: raw.direction, valuePerUnit: raw.value, positionAtoms: '100000', paymentMicros: '-500', source: 'lighter-mainnet-fundings-1h', raw, recordedAt: new Date(now).toISOString() };
  const sha256 = new Bun.CryptoHasher('sha256').update(JSON.stringify(event)).digest('hex');
  store.db.query('INSERT INTO paper_funding VALUES (?,?,?)').run(1, raw.timestamp, JSON.stringify({ ...event, sha256 }));
  store.set('paperBaselineHalt', true); store.set('paperBaselineIssue', { day: today, error: 'Delayed funding changes the immutable opening baseline; reconciliation required' });
  store.audit('PAPER_BASELINE_HALT', 'Delayed funding changes the immutable opening baseline; reconciliation required');
  store.db.close();
}
if (process.env.PAPER_FIXTURE_LATENCY_MS) {
  mkdirSync('data', { recursive: true });
  const store = new Store('data/terminal.sqlite');
  store.set('paperSession', { capital: 10000, enabled: false, feeBps: 2, latencyMs: Number(process.env.PAPER_FIXTURE_LATENCY_MS), createdAt: new Date().toISOString() });
  store.db.close();
}
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: any, init?: any) => {
  const url = String(input);
  if (!['mainnet.zklighter.elliot.ai', 'testnet.zklighter.elliot.ai'].includes(new URL(url).hostname)) throw new Error(`Unexpected outbound test request: ${url}`);
  if (url.includes('/orderBookDetails')) return Response.json({ code: 200, order_book_details: [
    { symbol: 'BTC', status: 'active', market_type: 'perp', min_initial_margin_fraction: 500, market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '0.00001', min_quote_amount: '10', last_trade_price: '50000' },
    { symbol: 'ETH', status: 'active', market_type: 'perp', min_initial_margin_fraction: 1000, market_id: 2, supported_size_decimals: 4, supported_price_decimals: 2, min_base_amount: '0.0001', min_quote_amount: '10', last_trade_price: '2000' },
  ] });
  if (url.includes('/orderBookOrders') && url.includes('market_id=2')) return Response.json({ code: 200, bids: [{ price: '2000', remaining_base_amount: '10' }], asks: [{ price: '2001', remaining_base_amount: '10' }] });
  if (url.includes('/orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '50000', remaining_base_amount: '1' }], asks: [{ price: '50010', remaining_base_amount: '0.001' }, { price: '50020', remaining_base_amount: '0.001' }] });
  return Response.json({ code: 200, order_books: [] });
}, { preconnect: originalFetch.preconnect }) as typeof fetch;
// No real WebSocket traffic in browser acceptance; real transport is covered separately.
let fixtureTradeId = Date.now() * 1000;
let fixtureDisconnected = false;
class FixtureSocket {
  readyState = 1;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror = null; onclose: ((event: any) => void) | null = null;
  private timer = setTimeout(() => this.onopen?.({}), fixtureDisconnected ? 2500 : 0);
  private subscriptions = new Map<string, number>();
  private updates = setInterval(() => {
    if (!fixtureDisconnected && existsSync('data/fixture-disconnect.flag')) { fixtureDisconnected = true; this.onclose?.({}); return; }
    for (const [channel, nonce] of this.subscriptions) { this.emit(channel, nonce + 1, false); this.subscriptions.set(channel, nonce + 1); }
  }, 500);
  send(raw: string) {
    const message = JSON.parse(raw);
    if (message.type !== 'subscribe') return;
    this.subscriptions.set(message.channel, 1);
    queueMicrotask(() => this.emit(message.channel, 1, true));
  }
  private emit(channel: string, nonce: number, snapshot: boolean) {
    if (this.readyState !== 1) return;
    const [kind, rawId] = channel.split('/'), id = Number(rawId), eth = id === 2;
    const tradeId = ++fixtureTradeId;
    const payload = kind === 'trade' ? { nonce, liquidation_trades: [], trades: [{ trade_id: tradeId, trade_id_str: String(tradeId),
      type: 'trade', market_id: id, price: eth ? '2000' : '50000', size: '0.001', is_maker_ask: true,
      tx_hash: 'a'.repeat(64), block_height: nonce, timestamp: Date.now(), transaction_time: Date.now() * 1000 }] }
      : kind === 'market_stats' ? { market_stats: { market_id: id, symbol: eth ? 'ETH' : 'BTC', mark_price: eth ? '2000' : '50000', index_price: eth ? '2000' : '50000', last_trade_price: eth ? '2000' : '50000', funding_rate: '0.001', current_funding_rate: '-0.002', funding_timestamp: Date.now() - 3600000 } }
      : { order_book: { code: 0, nonce, begin_nonce: nonce - 1, bids: snapshot ? [{ price: eth ? '2000' : '50000', size: '1' }] : [], asks: snapshot ? eth ? [{ price: '2001', size: '10' }] : [{ price: '50010', size: '0.001' }, { price: '50020', size: '0.001' }] : [] } };
    this.onmessage?.({ data: JSON.stringify({ type: `${snapshot ? 'subscribed' : 'update'}/${kind}`, channel: `${kind}:${id}`, ...(kind === 'trade' ? {} : { timestamp: Date.now() }), ...payload }) });
  }
  close() { clearTimeout(this.timer); clearInterval(this.updates); this.readyState = 3; }
}
globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
export {};