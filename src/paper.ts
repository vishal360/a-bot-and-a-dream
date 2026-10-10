import type { Store } from './store';
import { type Fill, type Mark } from './ledger';
import { lighterHosts } from './lighter';
import { matchIOC, units } from './paper-math';
import { paperBalance, markedMicros, paperAnalytics } from './paper-ledger';

const account = 'paper-mainnet';
type Level = { price: number; quantity: number };
export function parseDepth(body: any) {
  if (body.code !== 200 || !Array.isArray(body.bids) || !Array.isArray(body.asks)) throw new Error('Invalid depth response');
  const parse = (rows: any[], side: number): Level[] => {
    const levels = rows.map(r => ({ price: Number(r.price), quantity: Number(r.remaining_base_amount) }));
    if (!levels.length || levels.some(l => !Number.isFinite(l.price) || l.price <= 0 || !Number.isFinite(l.quantity) || l.quantity <= 0)) throw new Error('Invalid or empty depth');
    const aggregated = new Map<number, bigint>();
    for (const level of levels) aggregated.set(level.price, (aggregated.get(level.price) ?? 0n) + units(level.quantity, 8));
    return [...aggregated].map(([price, quantity]) => {
      if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Depth quantity overflow');
      return { price, quantity: Number(quantity) / 1e8 };
    }).sort((a, b) => side * (a.price - b.price));
  };
  const bids = parse(body.bids, -1), asks = parse(body.asks, 1);
  if (bids[0].price >= asks[0].price) throw new Error('Crossed depth');
  return { bids, asks };
}

/** Interim cash-collateralized, long-only BTC price simulator. NOT a perpetual account. */
export class Paper {
  private busy = false;
  private lastUse = 0;
  private observationBusy = false;
  constructor(private store: Store, private request: typeof fetch = fetch) {
    store.db.exec('CREATE TABLE IF NOT EXISTS paper_orders (id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS paper_observations (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS paper_liquidity (key TEXT PRIMARY KEY,consumed TEXT NOT NULL)');
    // Migrate recorded depth legs once; never grant old fills fresh liquidity on upgrade.
    store.db.transaction(() => {
      if (store.get('paperLiquidityVersion') !== null) return;
      const rows = store.db.query("SELECT payload FROM paper_orders WHERE json_extract(payload,'$.filled')>0").all() as { payload: string }[];
      for (const row of rows) {
        const order = JSON.parse(row.payload);
        const observation = store.db.query('SELECT payload FROM paper_observations WHERE id=?').get(order.observationId) as { payload: string } | null;
        if (!observation || !Array.isArray(order.executions)) { store.set('paperLiquidityUnreconciled', true); continue; }
        const marketId = JSON.parse(observation.payload).market?.market_id;
        if (!Number.isSafeInteger(marketId)) { store.set('paperLiquidityUnreconciled', true); continue; }
        for (const leg of order.executions) {
          const key = `${marketId}:${order.side}:${leg.price}`, old = store.db.query('SELECT consumed FROM paper_liquidity WHERE key=?').get(key) as { consumed: string } | null;
          store.db.query('INSERT OR REPLACE INTO paper_liquidity VALUES (?,?)').run(key, (BigInt(old?.consumed ?? '0') + units(leg.quantity, 8)).toString());
        }
      }
      store.set('paperLiquidityVersion', 1);
    }).immediate();
    if (!store.get('paperSession')) store.set('paperSession', { capital: 10000, enabled: false, feeBps: 2, latencyMs: 300, createdAt: new Date().toISOString() });
    // An interrupted IOC is never replayed, and activation never survives restart.
    store.set('paperSession', { ...store.get('paperSession'), enabled: false });
    const interrupted = store.db.query("SELECT payload FROM paper_orders WHERE json_extract(payload,'$.status')='pending'").all();
    for (const row of interrupted as { payload: string }[]) this.save({ ...JSON.parse(row.payload), status: 'rejected', error: 'Interrupted by restart; not replayed' });
  }
  orders(): any[] { return this.store.db.query('SELECT payload FROM paper_orders ORDER BY rowid DESC LIMIT 100').all().map((r: any) => JSON.parse(r.payload)); }
  private save(order: any) { this.store.db.query('INSERT OR REPLACE INTO paper_orders VALUES (?,?)').run(order.id, JSON.stringify(order)); }
  private fills() {
    return this.store.db.query('SELECT payload FROM fills WHERE account=? ORDER BY time,rowid').all(account).map((r: any) => JSON.parse(r.payload) as Fill);
  }
  private checkLoss(day: string, bid: number) {
    const balance = paperBalance(this.fills(), this.store.get('paperSession').capital);
    const equity = balance.cash + markedMicros(balance.quantity, bid);
    const key = `paperBaselineMicros:${day}`;
    if (this.store.get(key) === null) {
      const legacy = this.store.get(`paperBaseline:${day}`);
      this.store.set(key, (legacy === null ? equity : units(legacy, 6)).toString());
    }
    if (equity * 100n <= BigInt(this.store.get(key)) * 94n ||
        (balance.daily.get(day) ?? 0n) <= -units(this.store.get('risk').dailyLoss, 6)) {
      if (!this.store.get('paperLossHalt')) this.store.audit('PAPER_LOSS_HALT', `UTC ${day}: integer equity/realized loss threshold reached; no automatic reset`);
      this.store.set('paperLossHalt', true);
    }
  }
  summary() {
    return paperAnalytics(this.fills(), this.store.get('marks'), this.store.get('paperSession').capital);
  }
  status() {
    const rows = this.store.db.query('SELECT payload FROM paper_observations ORDER BY rowid DESC LIMIT 300').all() as { payload: string }[];
    const observations = rows.map(r => JSON.parse(r.payload)).reverse();
    const latest = observations.at(-1);
    return { ...this.store.get('paperSession'), account, model: 'Long-only, 1x BTC price simulation; no funding, shorts or liquidation',
      feed: this.store.get('paperFeed'), lossHalted: !!this.store.get('paperLossHalt'), halted: !!this.store.get('halted') || !!this.store.get('executionLossHalt'),
      allocationPct: this.store.get('allocationPct') ?? 0, risk: this.store.get('risk'), market: latest?.market ?? null,
      depth: latest ? { bids: latest.bids.slice(0, 8), asks: latest.asks.slice(0, 8) } : null,
      prices: observations.map(o => ({ time: o.time, bid: o.bids[0].price, ask: o.asks[0].price })),
      fills: this.fills().slice(-100).reverse(), orders: this.orders(), analytics: this.summary() };
  }
  configure(body: any) {
    if (typeof body.enabled !== 'boolean') throw new Error('Explicit enabled boolean required');
    if (body.enabled && (this.store.get('halted') || this.store.get('paperLossHalt') || this.store.get('executionLossHalt'))) throw new Error('Risk halt latched');
    this.store.set('paperSession', { ...this.store.get('paperSession'), enabled: body.enabled });
    this.store.audit('PAPER_ACTIVATION', String(body.enabled));
    return this.status();
  }
  private async get(path: string) {
    const start = Date.now(), response = await this.request(lighterHosts.mainnet + path, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Mainnet data unavailable');
    const body = await response.json();
    if (Date.now() - start > 4000) throw new Error('Depth request too slow');
    return body;
  }
  async observe() {
    if (this.observationBusy) throw new Error('Depth observation already in progress');
    this.observationBusy = true;
    try {
      const details = await this.get('/api/v1/orderBookDetails');
      const market = details.code === 200 && details.order_book_details?.find((m: any) => m.symbol === 'BTC' && m.status === 'active');
      if (!market || !Number.isSafeInteger(market.market_id) || !Number.isInteger(market.supported_size_decimals) || market.supported_size_decimals < 0 || market.supported_size_decimals > 8 || !Number.isFinite(Number(market.min_base_amount)) || Number(market.min_base_amount) <= 0) throw new Error('BTC precision/minimum metadata unavailable');
      const raw = await this.get(`/api/v1/orderBookOrders?market_id=${market.market_id}&limit=100`);
      const depth = parseDepth(raw), time = new Date().toISOString(), id = crypto.randomUUID();
      for (const level of [...depth.bids, ...depth.asks]) {
        units(level.price, market.supported_price_decimals); units(level.quantity, market.supported_size_decimals);
      }
      const observation = { id, time, market, raw, ...depth };
      this.store.db.transaction(() => {
        this.store.db.query('INSERT INTO paper_observations VALUES (?,?)').run(id, JSON.stringify(observation));
        this.store.db.exec(`DELETE FROM paper_observations WHERE id NOT IN
          (SELECT id FROM paper_observations ORDER BY rowid DESC LIMIT 1000)
          AND id NOT IN (SELECT json_extract(payload,'$.observationId') FROM paper_orders
            WHERE json_extract(payload,'$.filled')>0 AND json_extract(payload,'$.observationId') IS NOT NULL)`);
        const mark: Mark = { account, symbol: 'BTC-USD', price: depth.bids[0].price, time, source: 'lighter-mainnet-rest-bid' };
        this.store.set('marks', [...(this.store.get('marks') as Mark[]).filter(m => m.account !== account), mark]);
        this.store.set('paperFeed', { status: 'connected / REST snapshot, not sequenced', time, bid: depth.bids[0].price, ask: depth.asks[0].price });
        this.checkLoss(time.slice(0, 10), depth.bids[0].price);
      }).immediate();
      return observation;
    } catch (e) { this.store.set('paperFeed', { ...this.store.get('paperFeed'), status: 'disconnected', error: (e as Error).message }); throw e; }
    finally { this.observationBusy = false; }
  }
  async order(body: any) {
    if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.id) || !['buy', 'sell'].includes(body.side) || !Number.isFinite(body.quantity) || body.quantity <= 0 || body.quantity > 100) throw new Error('Invalid IOC order; provide unique id, buy/sell and BTC quantity');
    const prior = this.store.db.query('SELECT payload FROM paper_orders WHERE id=?').get(body.id) as { payload: string } | null;
    if (prior) { const o = JSON.parse(prior.payload); if (o.side !== body.side || o.quantity !== body.quantity) throw new Error('Conflicting order ID'); return o; }
    if (this.busy || Date.now() - this.lastUse < 1000) throw new Error('Paper matcher busy; wait before next order');
    this.busy = true;
    const order: any = { id: body.id, side: body.side, quantity: body.quantity, time: new Date().toISOString(), status: 'pending', filled: 0 };
    let claimed = false;
    try {
      this.store.db.transaction(() => {
        if (this.store.db.query("SELECT id FROM paper_orders WHERE json_extract(payload,'$.status')='pending'").get()) throw new Error('Paper matcher busy; unresolved pending order');
        this.store.db.query('INSERT INTO paper_orders VALUES (?,?)').run(order.id, JSON.stringify(order));
      }).immediate();
      claimed = true;
      await Bun.sleep(this.store.get('paperSession').latencyMs);
      const observation = await this.observe();
      return this.store.db.transaction(() => {
        if (Date.now() - Date.parse(observation.time) > 2000) throw new Error('Stale depth');
        const decimals = observation.market.supported_size_decimals;
        if (units(body.quantity, decimals) < units(observation.market.min_base_amount, decimals)) throw new Error('Quantity violates venue precision/minimum');
        const balance = paperBalance(this.fills(), this.store.get('paperSession').capital);
        const requested = units(body.quantity, 8), reducing = body.side === 'sell' && requested <= balance.quantity;
        const minQuote = Number(observation.market.min_quote_amount);
        if (!Number.isFinite(minQuote) || minQuote < 0) throw new Error('Invalid venue minimum quote amount');
        if (markedMicros(requested, body.side === 'buy' ? observation.asks[0].price : observation.bids[0].price) < units(observation.market.min_quote_amount, 6)) throw new Error(`Quantity violates venue minimum quote amount: order must be worth at least $${minQuote}. Increase BTC quantity using the current ${body.side === 'buy' ? 'ask' : 'bid'} price.`);
        if (body.side === 'sell' && !reducing) throw new Error('Long-only simulation: sell cannot exceed holdings');
        const session = this.store.get('paperSession'), risk = this.store.get('risk');
        if (!reducing && (!session.enabled || this.store.get('halted') || this.store.get('paperLossHalt') || this.store.get('executionLossHalt'))) throw new Error('Paper activation required or risk halt latched');
        if (!reducing && this.store.get('paperLiquidityUnreconciled')) throw new Error('Historical liquidity cannot be reconciled; exposure increases disabled');
        if (!reducing && (this.store.db.query('SELECT COUNT(*) AS n FROM risk_reservations').get() as any).n > 0) throw new Error('Unresolved shared risk reservations');
        const rawLevels = body.side === 'buy' ? observation.asks : observation.bids;
        const liquidityKey = (price: number) => `${observation.market.market_id}:${body.side}:${price}`;
        // REST cannot prove queue replenishment. Persist consumption by side/price
        // and do not reuse it after refresh or restart. Deliberately conservative.
        const levels = rawLevels.map(level => {
          const row = this.store.db.query('SELECT consumed FROM paper_liquidity WHERE key=?').get(liquidityKey(level.price)) as { consumed: string } | null;
          const remaining = units(level.quantity, 8) - BigInt(row?.consumed ?? '0');
          return { price: level.price, quantity: remaining > 0n ? Number(remaining) / 1e8 : 0 };
        }).filter(level => {
          const best = units(rawLevels[0].price, observation.market.supported_price_decimals);
          const price = units(level.price, observation.market.supported_price_decimals);
          const distance = price > best ? price - best : best - price;
          return level.quantity > 0 && distance * 10000n <= best * 50n;
        });
        if (!levels.length) throw new Error('No unused REST liquidity; verified replenishment required');
        const matched = matchIOC(body.side, body.quantity, levels, decimals, observation.market.supported_price_decimals, session.feeBps);
        const { filled, cost, fee } = matched;
        const allocation = this.store.get('allocationPct') ?? 0;
        if (!Number.isInteger(allocation) || allocation < 0 || allocation > 100) throw new Error('Invalid allocation policy');
        const quote = BigInt(matched.quoteMicros), charge = quote + BigInt(matched.feeMicros);
        const heldValue = markedMicros(balance.quantity, levels[0].price);
        const equity = balance.cash + markedMicros(balance.quantity, observation.bids[0].price);
        if (!reducing) {
          const fail = (message: string) => { throw new Error(`Paper risk limit: ${message}`); };
          if (allocation === 0) fail('allocation is 0%. Set and save a paper allocation in the order ticket before buying.');
          if (quote > units(risk.maxOrderNotional, 6) || markedMicros(requested, levels[0].price) > units(risk.maxOrderNotional, 6)) fail(`order exceeds the $${risk.maxOrderNotional} per-order cap. Reduce BTC quantity.`);
          if (charge > balance.cash) fail(`purchase plus fees exceeds $${(Number(balance.cash) / 1e6).toFixed(2)} available cash.`);
          if (heldValue + charge > units(risk.maxGrossNotional, 6)) fail(`total exposure exceeds the $${risk.maxGrossNotional} account cap.`);
          if (heldValue + charge > equity * BigInt(allocation) / 100n) fail(`existing BTC plus purchase and fees exceeds your ${allocation}% allocation. Reduce quantity or review allocation.`);
        }
        if (!filled) throw new Error('No executable depth');
        const fill: Fill = { id: body.id, account, botId: 'orion', symbol: 'BTC-USD', side: body.side, quantity: filled, price: cost / filled, fee, multiplier: 1, source: 'paper', reason: `Mainnet REST depth IOC; observation ${observation.id}; simulated, not venue execution`, time: new Date().toISOString() };
        fill.settlement = { version: 1, quantityAtoms: units(filled, 8).toString(), quoteMicros: matched.quoteMicros, feeMicros: matched.feeMicros };
        paperBalance([...this.fills(), fill], session.capital);
        for (const leg of matched.executions) {
          const key = liquidityKey(leg.price), row = this.store.db.query('SELECT consumed FROM paper_liquidity WHERE key=?').get(key) as { consumed: string } | null;
          this.store.db.query('INSERT OR REPLACE INTO paper_liquidity VALUES (?,?)').run(key, (BigInt(row?.consumed ?? '0') + units(leg.quantity, 8)).toString());
        }
        this.store.db.query('INSERT INTO fills VALUES (?,?,?,?)').run(account, fill.id, fill.time, JSON.stringify(fill));
        this.checkLoss(fill.time.slice(0, 10), observation.bids[0].price);
        const result = { ...order, ...matched, status: matched.canceled === 0 ? 'filled' : 'partial-canceled', observationId: observation.id };
        this.save(result); this.store.audit('MAINNET_PAPER_FILL', JSON.stringify(result));
        return result;
      }).immediate();
    } catch (e) { const result = { ...order, status: 'rejected', error: (e as Error).message }; if (claimed) this.save(result); return result; }
    finally { this.busy = false; this.lastUse = Date.now(); }
  }
}