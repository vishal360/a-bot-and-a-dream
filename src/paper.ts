import type { Store } from './store';
import { type Fill, type Mark } from './ledger';
import { lighterHosts } from './lighter';
import { matchIOC, units } from './paper-math';
import { paperBalance, markedMicros, paperAnalytics, positionEffect } from './paper-ledger';
import { PaperFunding, readPaperEvents } from './paper-funding';
import { paperMargin } from './paper-margin';
import type { LighterStream } from './lighter-stream';
import { PaperOrders, type PaperIntent } from './paper-orders';
import { PaperRiskDays } from './paper-risk-days';

export function leverageLimit(market: any) {
  const fraction = market?.min_initial_margin_fraction;
  return Number.isInteger(fraction) && fraction > 0 && fraction <= 10000 ? Math.max(1, Math.min(20, Math.floor(10000 / fraction))) : 1;
}

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

/** Signed perpetual paper simulator. Never submits venue transactions. */
export class Paper {
  private busy = false;
  private lastUse = 0;
  private observationBusy = false;
  private refreshBusy = false;
  private protectionBusy = false;
  private metadataBusy = false;
  private metadataAttempt = -Infinity;
  private metadataRead = 0;
  private prices = new Map<string, { time: string; bid: number; ask: number }[]>();
  private lifecycle: PaperOrders;
  private riskDays: PaperRiskDays;
  private funding: PaperFunding;
  constructor(private store: Store, private request: typeof fetch = fetch, private stream?: LighterStream) {
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
    this.funding = new PaperFunding(store);
    this.lifecycle = new PaperOrders(store);
    this.riskDays = new PaperRiskDays(store);
  }
  orders(): any[] { return this.store.db.query('SELECT payload FROM paper_orders ORDER BY rowid DESC LIMIT 100').all().map((r: any) => JSON.parse(r.payload)); }
  cancel(body: any) {
    if (typeof body?.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.id)) throw new Error('Stable order ID required');
    return this.lifecycle.cancel(body.id);
  }
  private fills() {
    return this.store.db.query('SELECT payload FROM fills WHERE account=? ORDER BY time,rowid').all(account).map((r: any) => JSON.parse(r.payload) as Fill);
  }
  private balance() { return paperBalance(this.fills(), this.store.get('paperSession').capital, readPaperEvents(this.store)); }
  private marginState() { return paperMargin(this.balance(), this.marks(), this.store.get('paperMarkets') ?? []); }
  async settleFunding(now = Date.now()) {
    await this.funding.refresh(this.fills(), this.store.get('paperSession').capital, this.store.get('paperMarkets') ?? [], path => this.get(path), () => this.lifecycle.active(), now);
  }
  private market(symbol: string): any { return (this.store.get('paperMarkets') ?? []).find((m: any) => m.symbol === symbol); }
  private quote(symbol: string) { const market = this.market(symbol); return market && this.stream ? this.stream.read(market.market_id) : null; }
  private marks(): Mark[] {
    const marks: Mark[] = this.store.get('marks');
    if (!this.stream) return marks;
    const fresh = (this.store.get('paperMarkets') ?? []).flatMap((m: any) => {
      const q = this.stream!.read(m.market_id, 1);
      return q?.stats ? [{ account, symbol: `${m.symbol}-USD`, price: q.stats.mark, time: q.stats.receivedAt, source: 'lighter-mainnet-ws-mark' }] : [];
    });
    // No silent REST fallback, stale marks, bid/mid or external-venue substitution.
    return [...marks.filter(m => m.account !== account), ...fresh];
  }
  private feed(symbol: string): any {
    if (!this.stream) return this.store.get(`paperFeed:${symbol}`) ?? (symbol === 'BTC' ? this.store.get('paperFeed') : null);
    const market = this.market(symbol), d = market ? this.stream.display(market.market_id) : null;
    return { status: d && !d.stale ? 'connected / validated WebSocket' : 'disconnected', time: d?.time ?? null,
      bid: d?.bid ?? null, ask: d?.ask ?? null, mark: d?.stats?.mark ?? null, index: d?.stats?.index ?? null, last: d?.stats?.last ?? null,
      fundingRate: d?.stats?.fundingRate ?? null, estimatedFundingRate: d?.stats?.estimatedFundingRate ?? null,
      ageMs: d?.ageMs ?? null, statsAgeMs: d?.statsAgeMs ?? null, markTime: d?.stats?.receivedAt ?? null,
      displayOnly: d?.displayOnly ?? true, reason: d ? d.reason : 'Market metadata required', state: d?.state ?? 'waiting for markets' };
  }
  private portfolio(balance: ReturnType<typeof paperBalance>, fresh = true) {
    let exposure = 0n, unrealized = 0n;
    for (const [symbol, p] of balance.inventory) {
      if (!p.quantity) continue;
      const mark = this.marks().find(m => m.account === account && m.symbol === symbol);
      const age = mark ? Date.now() - Date.parse(mark.time) : NaN;
      const feed = this.feed(symbol.slice(0, -4));
      if (!mark || !Number.isFinite(mark.price) || mark.price <= 0 || !Number.isFinite(age) || age < 0 || (fresh && (age > 15000 || feed?.status === 'disconnected'))) throw new Error(`Fresh ${symbol} valuation required; refresh held markets before increasing exposure`);
      exposure += markedMicros(p.quantity < 0n ? -p.quantity : p.quantity, mark.price);
      unrealized += markedMicros(p.quantity, mark.price) - (p.quantity > 0n ? p.basis : -p.basis);
    }
    const margin = [...balance.inventory.values()].reduce((sum, p) => sum + p.margin, 0n);
    return { exposure, equity: balance.cash + unrealized + margin };
  }
  private checkLoss(day: string) {
    const balance = this.balance();
    let equity: bigint | null = null;
    try { equity = this.portfolio(balance).equity; } catch { /* Missing prices cannot create a new equity baseline. */ }
    let baseline: string | null = null;
    try {
      const events = readPaperEvents(this.store);
      this.riskDays.ensure(day, equity, this.fills(), this.store.get('paperSession'), Date.now(), events);
      baseline = this.riskDays.effective(day, events);
    }
    catch (error) {
      if (!this.store.get('paperBaselineHalt')) this.store.audit('PAPER_BASELINE_HALT', (error as Error).message);
      this.store.set('paperBaselineHalt', true);
      this.store.set('paperBaselineIssue', { day, error: (error as Error).message });
    }
    if ((equity !== null && baseline !== null && equity * 100n <= BigInt(baseline) * 94n) ||
        (balance.daily.get(day) ?? 0n) <= -units(this.store.get('risk').dailyLoss, 6)) {
      if (!this.store.get('paperLossHalt')) this.store.audit('PAPER_LOSS_HALT', `UTC ${day}: integer equity/realized loss threshold reached; no automatic reset`);
      this.store.set('paperLossHalt', true);
    }
  }
  summary() {
    return paperAnalytics(this.fills(), this.marks(), this.store.get('paperSession').capital, new Date(), readPaperEvents(this.store));
  }
  currentMarks() { return this.marks(); }
  status() {
    const symbol: string = this.store.get('paperSymbol') ?? 'BTC';
    const rows = this.store.db.query("SELECT payload FROM paper_observations WHERE json_extract(payload,'$.market.symbol')=? ORDER BY rowid DESC LIMIT 300").all(symbol) as { payload: string }[];
    const observations = rows.map(r => JSON.parse(r.payload)).reverse();
    const latest = observations.at(-1);
    const q = this.quote(symbol), market = this.market(symbol) ?? latest?.market ?? null;
    return { ...this.store.get('paperSession'), account, symbol, markets: this.store.get('paperMarkets') ?? [], protections: this.store.get('paperProtections') ?? {}, model: 'Signed perpetual paper; delayed funding and approximate depth liquidation; no venue orders',
      funding: this.funding.status(), margin: this.marginState(), liquidation: this.store.get('paperLiquidation'),
      leverage: (this.store.get('paperLeverage') ?? {})[symbol] ?? 1, maxLeverage: leverageLimit(market), streaming: !!this.stream,
      feed: this.feed(symbol), lossHalted: !!this.store.get('paperLossHalt'), halted: !!this.store.get('halted') || !!this.store.get('executionLossHalt'),
      allocationPct: this.store.get('allocationPct') ?? 0, risk: this.store.get('risk'), market, orderManagement: this.lifecycle.status(), riskDays: this.riskDays.status(),
      depth: this.stream ? q ? { bids: q.bids.slice(0, 8), asks: q.asks.slice(0, 8) } : null : latest ? { bids: latest.bids.slice(0, 8), asks: latest.asks.slice(0, 8) } : null,
      prices: this.stream ? this.prices.get(symbol) ?? [] : observations.map(o => ({ time: o.time, bid: o.bids[0].price, ask: o.asks[0].price })),
      fills: this.fills().slice(-100).reverse(), orders: this.orders(), analytics: this.summary() };
  }
  setLeverage(body: any) {
    if (this.busy || this.lifecycle.pending()) throw new Error('Wait for the pending IOC before changing leverage');
    const symbol = body.symbol ?? this.store.get('paperSymbol') ?? 'BTC', max = leverageLimit(this.market(symbol));
    if (!this.market(symbol) || !Number.isInteger(body.leverage) || body.leverage < 1 || body.leverage > max) throw new Error(`Leverage must be a whole number from 1 to ${max} for this market (20x application cap)`);
    if (this.summary().positions.some(p => p.symbol === `${symbol}-USD` && p.leverage !== body.leverage)) throw new Error('Close the position before changing leverage');
    this.store.set('paperLeverage', { ...this.store.get('paperLeverage'), [symbol]: body.leverage });
    this.store.audit('PAPER_LEVERAGE', `${symbol}: ${body.leverage}x; paper only`);
    return this.status();
  }
  configure(body: any) {
    if (typeof body.enabled !== 'boolean') throw new Error('Explicit enabled boolean required');
    if (body.enabled) this.checkLoss(new Date().toISOString().slice(0, 10));
    if (body.enabled && (this.store.get('halted') || this.store.get('paperLossHalt') || this.store.get('executionLossHalt'))) throw new Error('Risk halt latched');
    if (body.enabled && this.riskDays.status().blocked) throw new Error('Paper baseline reconciliation required');
    this.store.set('paperSession', { ...this.store.get('paperSession'), enabled: body.enabled });
    this.store.audit('PAPER_ACTIVATION', String(body.enabled));
    return this.status();
  }
  async reconcileBaseline(body: any) {
    if (body?.confirm !== 'RECONCILE PAPER BASELINE') throw new Error('Explicit paper baseline reconciliation confirmation required');
    if (this.busy || this.lifecycle.pending()) throw new Error('Wait for the pending IOC before reconciliation');
    await this.settleFunding();
    if (!this.lifecycle.active() || this.busy || this.lifecycle.pending()) throw new Error('Paper matching state changed during reconciliation; retry when idle');
    if (this.funding.status().blocked) throw new Error('Funding must be reconciled first');
    this.riskDays.reconcile(this.fills(), this.store.get('paperSession'), readPaperEvents(this.store));
    this.checkLoss(new Date().toISOString().slice(0, 10));
    if (this.riskDays.status().blocked) throw new Error(this.riskDays.status().error ?? 'Paper baseline reconciliation required');
    return this.status();
  }
  async select(body: any) {
    if (typeof body.symbol !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(body.symbol)) throw new Error('Invalid market symbol');
    if (this.stream) { await this.refreshMetadata(); if (!this.market(body.symbol)) throw new Error('Unknown active market'); }
    else await this.observe(body.symbol);
    this.store.set('paperSymbol', body.symbol);
    this.syncMarkets();
    return this.status();
  }
  private syncMarkets() {
    if (!this.stream) return;
    const symbols = new Set([this.store.get('paperSymbol') ?? 'BTC', ...this.summary().positions.map(p => p.symbol.slice(0, -4))]);
    const watched = (this.store.get('paperMarkets') ?? []).filter((m: any) => symbols.has(m.symbol));
    try {
      if (watched.length !== symbols.size) throw new Error('Complete watched-market metadata required');
      this.stream.watch(watched.map((m: any) => ({ symbol: m.symbol, market_id: m.market_id, supported_price_decimals: m.supported_price_decimals, supported_size_decimals: m.supported_size_decimals })));
    } catch { this.stream.watch([]); }
  }
  async refreshMetadata() {
    if (this.metadataRead && performance.now() - this.metadataRead < 60000) { this.syncMarkets(); return; }
    if (this.metadataBusy) throw new Error('Market metadata refresh in progress');
    if (performance.now() - this.metadataAttempt < 60000) throw new Error('Market metadata retry backoff');
    this.metadataAttempt = performance.now();
    this.metadataBusy = true;
    try {
      const details = await this.get('/api/v1/orderBookDetails');
      if (details.code !== 200 || !Array.isArray(details.order_book_details)) throw new Error('Invalid venue metadata');
      const markets = details.order_book_details.filter((m: any) => m.status === 'active' && m.market_type === 'perp');
      if (!markets.length || markets.some((m: any) => typeof m.symbol !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(m.symbol) || !Number.isSafeInteger(m.market_id) || m.market_id < 0 ||
        [m.supported_size_decimals, m.supported_price_decimals].some(n => !Number.isInteger(n) || n < 0 || n > 8) || !Number.isFinite(Number(m.min_base_amount)) || Number(m.min_base_amount) <= 0 || !Number.isFinite(Number(m.min_quote_amount)) || Number(m.min_quote_amount) < 0) ||
        new Set(markets.map((m: any) => m.symbol)).size !== markets.length || new Set(markets.map((m: any) => m.market_id)).size !== markets.length) throw new Error('Valid, unique active perpetual metadata required');
      this.store.set('paperMarkets', markets); this.metadataRead = performance.now(); this.syncMarkets();
    } finally { this.metadataBusy = false; }
  }
  async monitor() {
    if (!this.lifecycle.active() || !this.stream || this.protectionBusy) return;
    this.protectionBusy = true;
    try {
      const watched = new Set(this.stream.status().books.map(b => b.market.symbol));
      for (const symbol of this.prices.keys()) if (!watched.has(symbol)) this.prices.delete(symbol);
      for (const market of this.store.get('paperMarkets') ?? []) {
        const q = this.stream.read(market.market_id, 1);
        if (!q?.stats) continue;
        const points = this.prices.get(market.symbol) ?? [], last = points.at(-1);
        if (!last || Date.parse(q.receivedAt!) - Date.parse(last.time) >= 250) {
          points.push({ time: q.receivedAt!, bid: q.bids[0].price, ask: q.asks[0].price });
          if (points.length > 300) points.shift(); this.prices.set(market.symbol, points);
        }
      }
      await this.settleFunding();
      if (!this.lifecycle.active()) return;
      this.checkLoss(new Date().toISOString().slice(0, 10));
      await this.evaluateLiquidation();
      await this.evaluateProtections();
    } finally { this.protectionBusy = false; }
  }
  async refreshWatched() {
    if (this.refreshBusy) return;
    this.refreshBusy = true;
    try {
      if (this.stream) { try { await this.refreshMetadata(); } finally { await this.monitor(); } return; }
      const symbols = new Set<string>([this.store.get('paperSymbol') ?? 'BTC', ...this.summary().positions.map(p => p.symbol.slice(0, -4))]);
      for (const symbol of symbols) { try { await this.observe(symbol); } catch {} }
      await this.evaluateProtections();
    } finally { this.refreshBusy = false; }
  }
  protect(body: any) {
    const symbol = body.symbol ?? this.store.get('paperSymbol') ?? 'BTC';
    const p = this.summary().positions.find(p => p.symbol === `${symbol}-USD`);
    if (!p) throw new Error('An open position is required for protection');
    const market = (this.store.get('paperMarkets') ?? []).find((m: any) => m.symbol === symbol);
    if (!market) throw new Error('Refresh market metadata before setting protection');
    const stopLoss = body.stopLoss ?? null, takeProfit = body.takeProfit ?? null;
    for (const price of [stopLoss, takeProfit]) if (price !== null) {
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) throw new Error('Protection prices must be positive numbers or null');
      units(price, market.supported_price_decimals);
    }
    const long = p.quantity > 0;
    if ((stopLoss !== null || takeProfit !== null) && (!p.mark || p.stale || this.feed(symbol)?.status === 'disconnected' ||
        (stopLoss !== null && (long ? stopLoss >= p.mark : stopLoss <= p.mark)) || (takeProfit !== null && (long ? takeProfit <= p.mark : takeProfit >= p.mark))))
      throw new Error(long ? 'Use a stop below and a target above the fresh Lighter valuation price' : 'Use a stop above and a target below the fresh Lighter valuation price');
    const protections = this.store.get('paperProtections') ?? {};
    if (stopLoss === null && takeProfit === null) delete protections[symbol];
    else protections[symbol] = { symbol, stopLoss, takeProfit, version: crypto.randomUUID(), status: 'armed', updatedAt: new Date().toISOString(), lastError: null };
    this.store.set('paperProtections', protections);
    this.store.audit('PAPER_PROTECTION', JSON.stringify({ symbol, stopLoss, takeProfit }));
    return this.status();
  }
  private async evaluateProtections() {
    if (!this.lifecycle.active() || !this.store.get('paperSession').enabled || this.busy || this.lifecycle.pending()) return;
    const protections = this.store.get('paperProtections') ?? {};
    for (const [symbol, rule] of Object.entries(protections) as [string, any][]) {
      const p = this.summary().positions.find(p => p.symbol === `${symbol}-USD`);
      if (!p) { delete protections[symbol]; continue; }
      const feed = this.feed(symbol);
      if (!p.mark || p.stale || feed?.status === 'disconnected') { rule.lastError = 'Waiting for fresh Lighter depth and valuation'; continue; }
      if (rule.status === 'triggered') continue;
      const long = p.quantity > 0;
      const reason = rule.trigger ?? (rule.stopLoss !== null && (long ? p.mark <= rule.stopLoss : p.mark >= rule.stopLoss) ? 'stop-loss' : rule.takeProfit !== null && (long ? p.mark >= rule.takeProfit : p.mark <= rule.takeProfit) ? 'take-profit' : null);
      if (!reason) continue;
      rule.trigger = reason; // Trigger stays latched through rejected/partial exits and rebounds.
      this.store.set('paperProtections', protections); // Persist the trigger before the asynchronous exit.
      try {
        const result = await this.submit({ id: crypto.randomUUID(), symbol, side: long ? 'sell' : 'buy', quantity: Math.abs(p.quantity), type: 'market', reason }, 'protection');
        rule.status = result.status === 'filled' ? 'triggered' : 'armed';
        rule.lastError = result.error ?? (result.status === 'partial-canceled' ? 'Partial exit; remaining position still protected' : null);
        rule.lastOrderId = result.id;
        rule.trigger = reason;
      } catch (e) { rule.lastError = (e as Error).message; }
      // Only one automatic reduction per cycle; the shared IOC lock still applies.
      break;
    }
    // Preserve concurrent user edits/removals across an awaited exit request.
    if (!this.lifecycle.active()) return;
    const current = this.store.get('paperProtections') ?? {};
    for (const symbol of Object.keys(protections)) {
      if (!this.summary().positions.some(p => p.symbol === `${symbol}-USD`)) delete current[symbol];
      else if (current[symbol]?.version === protections[symbol].version) current[symbol] = protections[symbol];
    }
    this.store.set('paperProtections', current);
  }
  private async evaluateLiquidation() {
    if (!this.lifecycle.active() || !this.stream) return;
    const margin = this.marginState();
    if (margin.approximate || !['liquidating', 'closeout'].includes(margin.state)) return;
    if (!this.metadataRead || performance.now() - this.metadataRead > 120000) return;
    for (const order of this.orders().filter(o => o.status === 'pending' && o.effect === 'open')) this.lifecycle.cancel(order.id);
    if (this.busy || this.lifecycle.pending()) return;
    // Conservative full-position depth IOC, not venue zero-price/LLP/ADL replication.
    const p = this.summary().positions.sort((a, b) => (a.unrealized ?? 0) - (b.unrealized ?? 0))[0];
    if (!p) return;
    this.store.set('paperLiquidation', { state: margin.state, time: new Date().toISOString(), symbol: p.symbol, model: 'approximate full-position depth IOC; 1% notional surcharge; no LLP/ADL' });
    try {
      const result = await this.submit({ id: crypto.randomUUID(), symbol: p.symbol.slice(0, -4), side: p.quantity > 0 ? 'sell' : 'buy', quantity: Math.abs(p.quantity), type: 'market', reason: 'liquidation' }, 'liquidation');
      if (!this.lifecycle.active()) return;
      this.store.set('paperLiquidation', { ...this.store.get('paperLiquidation'), orderId: result.id, status: result.status, error: result.error ?? null });
    } catch (error) { if (this.lifecycle.active()) this.store.set('paperLiquidation', { ...this.store.get('paperLiquidation'), error: (error as Error).message }); }
  }
  private async get(path: string) {
    const start = Date.now(), response = await this.request(lighterHosts.mainnet + path, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Mainnet data unavailable');
    const body = await response.json();
    if (Date.now() - start > 4000) throw new Error('Depth request too slow');
    return body;
  }
  async observe(symbol: string = this.store.get('paperSymbol') ?? 'BTC') {
    if (this.stream) {
      const market = this.market(symbol), q = this.quote(symbol);
      if (!market || !q?.stats) throw new Error('Fresh validated Lighter WebSocket depth and mark required; no REST fallback');
      const observation = { id: crypto.randomUUID(), time: new Date().toISOString(), ...q, market, source: 'lighter-mainnet-ws' };
      this.store.db.query('INSERT INTO paper_observations VALUES (?,?)').run(observation.id, JSON.stringify(observation));
      this.pruneObservations();
      return observation;
    }
    if (this.observationBusy) throw new Error('Depth observation already in progress');
    this.observationBusy = true;
    try {
      const details = await this.get('/api/v1/orderBookDetails');
      const markets = details.code === 200 && Array.isArray(details.order_book_details) ? details.order_book_details.filter((m: any) => m.status === 'active' && typeof m.symbol === 'string' && /^[A-Za-z0-9._/-]{1,80}$/.test(m.symbol)) : [];
      this.store.set('paperMarkets', markets);
      const market = markets.find((m: any) => m.symbol === symbol);
      if (!market || !Number.isSafeInteger(market.market_id) || !Number.isInteger(market.supported_size_decimals) || market.supported_size_decimals < 0 || market.supported_size_decimals > 8 || !Number.isFinite(Number(market.min_base_amount)) || Number(market.min_base_amount) <= 0) throw new Error(`${symbol} precision/minimum metadata unavailable`);
      const raw = await this.get(`/api/v1/orderBookOrders?market_id=${market.market_id}&limit=100`);
      const depth = parseDepth(raw), time = new Date().toISOString(), id = crypto.randomUUID();
      for (const level of [...depth.bids, ...depth.asks]) {
        units(level.price, market.supported_price_decimals); units(level.quantity, market.supported_size_decimals);
      }
      const observation = { id, time, market, raw, ...depth };
      this.store.db.transaction(() => {
        this.store.db.query('INSERT INTO paper_observations VALUES (?,?)').run(id, JSON.stringify(observation));
        this.pruneObservations();
        const mark: Mark = { account, symbol: `${symbol}-USD`, price: depth.bids[0].price, time, source: 'lighter-mainnet-rest-bid' };
        this.store.set('marks', [...(this.store.get('marks') as Mark[]).filter(m => m.account !== account || m.symbol !== mark.symbol), mark]);
        const feed = { status: 'connected / REST snapshot, not sequenced', time, bid: depth.bids[0].price, ask: depth.asks[0].price };
        this.store.set(`paperFeed:${symbol}`, feed);
        if (symbol === 'BTC') this.store.set('paperFeed', feed);
        this.checkLoss(time.slice(0, 10));
      }).immediate();
      return observation;
    } catch (e) { const feed = { ...this.store.get(`paperFeed:${symbol}`), status: 'disconnected', error: (e as Error).message }; this.store.set(`paperFeed:${symbol}`, feed); if (symbol === 'BTC') this.store.set('paperFeed', feed); throw e; }
    finally { this.observationBusy = false; }
  }
  private pruneObservations() {
    this.store.db.exec(`DELETE FROM paper_observations WHERE id NOT IN
      (SELECT id FROM paper_observations ORDER BY rowid DESC LIMIT 1000)
      AND id NOT IN (SELECT json_extract(payload,'$.observationId') FROM paper_orders
        WHERE json_extract(payload,'$.filled')>0 AND json_extract(payload,'$.observationId') IS NOT NULL)`);
  }
  private prepare(order: any, observation: any) {
    this.lifecycle.assertPending(order.id);
    const { market } = observation, session = this.store.get('paperSession'), risk = this.store.get('risk');
    if (!Number.isInteger(session.feeBps) || session.feeBps < 0 || session.feeBps > 100 || !Number.isInteger(session.latencyMs) || session.latencyMs < 0 || session.latencyMs > 4000) throw new Error('Invalid paper simulation configuration');
    if (units(order.quantity, market.supported_size_decimals) < units(market.min_base_amount, market.supported_size_decimals)) throw new Error('Quantity violates venue precision/minimum');
    if (order.type === 'limit') units(order.limitPrice, market.supported_price_decimals);
    const balance = this.balance(), requested = units(order.quantity, 8);
    const held = balance.inventory.get(`${order.symbol}-USD`);
    const reducing = positionEffect(order.side, requested, held?.quantity ?? 0n) === 'reduce';
    order.effect = reducing ? 'reduce' : 'open';
    if (order.source !== 'manual' && !reducing) throw new Error('Automatic reductions cannot open exposure');
    if (reducing) order.leverage = held!.leverage;
    if (!Number.isInteger(order.leverage) || order.leverage < 1 || order.leverage > (reducing ? 20 : leverageLimit(market))) throw new Error('Leverage exceeds the market limit or 20x application cap');
    const best = order.side === 'buy' ? observation.asks[0].price : observation.bids[0].price;
    if (markedMicros(requested, best) < units(market.min_quote_amount, 6)) throw new Error(`Quantity violates venue minimum quote amount: order must be worth at least $${Number(market.min_quote_amount)}. Increase ${order.symbol} quantity using the current ${order.side === 'buy' ? 'ask' : 'bid'} price.`);
    let notional = 0n, charge = 0n;
    if (!reducing) {
      if (this.riskDays.status().blocked) throw new Error('Paper baseline reconciliation required; exposure increases disabled');
      if (this.store.get('paperFundingState')?.blocked) throw new Error('Funding reconciliation required; exposure increases disabled');
      if (!['healthy', 'unknown'].includes(this.marginState().state)) throw new Error('Paper margin requires reductions; exposure increases disabled');
      if (this.store.get('paperRecoveryHalt')) throw new Error('Paper recovery reconciliation required; exposure increases disabled');
      if (!session.enabled || this.store.get('halted') || this.store.get('paperLossHalt') || this.store.get('executionLossHalt')) throw new Error('Paper activation required or risk halt latched');
      if (this.store.get('paperLiquidityUnreconciled')) throw new Error('Historical liquidity cannot be reconciled; exposure increases disabled');
      if ((this.store.db.query('SELECT COUNT(*) AS n FROM risk_reservations').get() as any).n > 0) throw new Error('Unresolved shared risk reservations');
      if (held?.quantity && held.leverage !== order.leverage) throw new Error('Close the position before changing leverage');
      if (this.stream && (!this.metadataRead || performance.now() - this.metadataRead > 120000)) throw new Error('Fresh venue margin metadata required');
      if (market.is_frozen || market.market_config?.force_reduce_only) throw new Error('Market is frozen or reduce-only');
      const bestAtoms = units(best, market.supported_price_decimals);
      let ceiling = (bestAtoms * 10050n + 9999n) / 10000n;
      if (order.type === 'limit') ceiling = ceiling < units(order.limitPrice, market.supported_price_decimals) ? ceiling : units(order.limitPrice, market.supported_price_decimals);
      // Hold the full request at the 50bps IOC price ceiling, even if depth will underfill.
      const denominator = 100000000n * 10n ** BigInt(market.supported_price_decimals);
      notional = (requested * ceiling * 1000000n + denominator - 1n) / denominator;
      charge = (notional + BigInt(order.leverage) - 1n) / BigInt(order.leverage) + (notional * BigInt(session.feeBps) + 9999n) / 10000n;
      const allocation = this.store.get('allocationPct') ?? 0, { exposure, equity } = this.portfolio(balance);
      const fail = (message: string) => { throw new Error(`Paper risk limit: ${message}`); };
      if (!Number.isInteger(allocation) || allocation < 0 || allocation > 100) throw new Error('Invalid allocation policy');
      if (!allocation) fail('allocation is 0%. Set and save a paper allocation in the order ticket before buying.');
      if (notional > units(risk.maxOrderNotional, 6) || markedMicros(requested, best) > units(risk.maxOrderNotional, 6)) fail(`order exceeds the $${risk.maxOrderNotional} per-order cap. Reduce ${order.symbol} quantity.`);
      if (charge > balance.cash) fail(`initial margin plus fees exceeds $${(Number(balance.cash) / 1e6).toFixed(2)} available cash.`);
      if (exposure + notional > units(risk.maxGrossNotional, 6)) fail(`total exposure exceeds the $${risk.maxGrossNotional} account cap.`);
      const usedMargin = [...balance.inventory.values()].reduce((n, p) => n + p.margin, 0n);
      if (usedMargin + charge > equity * BigInt(allocation) / 100n) fail(`all existing position margins plus pending margin and fees exceed your ${allocation}% allocation. Reduce quantity or review allocation.`);
    }
    this.lifecycle.reserve({ id: order.id, generation: this.lifecycle.generation, symbol: order.symbol, side: order.side,
      quantityAtoms: requested.toString(), notionalMicros: notional.toString(), chargeMicros: charge.toString() });
    // Persist the admitted effect and held leverage as part of the pending evidence.
    const pending = this.lifecycle.get(order.id);
    this.store.db.query('UPDATE paper_orders SET payload=? WHERE id=?').run(JSON.stringify({ ...pending, effect: order.effect, leverage: order.leverage }), order.id);
  }
  async order(body: any) { return this.submit(body, 'manual'); }
  private async submit(body: any, source: 'manual' | 'protection' | 'liquidation') {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id', 'symbol', 'type', 'side', 'quantity', 'limitPrice', 'leverage', ...(source !== 'manual' ? ['reason'] : [])].includes(key))) throw new Error('Unknown paper order field');
    body = { ...body }; // The admitted intent cannot be mutated by an internal caller across awaits.
    const symbol: string = body.symbol ?? 'BTC', type: string = body.type ?? 'market';
    if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.id) || typeof symbol !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(symbol) || !['market', 'limit'].includes(type) || !['buy', 'sell'].includes(body.side) || !Number.isFinite(body.quantity) || body.quantity <= 0 || body.quantity > 1e9) throw new Error('Invalid IOC order; provide unique id, market, buy/sell and quantity');
    if (type === 'limit' && (typeof body.limitPrice !== 'number' || !Number.isFinite(body.limitPrice) || body.limitPrice <= 0)) throw new Error('Positive limit price required');
    if (type === 'market' && body.limitPrice !== undefined) throw new Error('Market IOC cannot specify a limit price');
    if (body.leverage !== undefined && (!Number.isInteger(body.leverage) || body.leverage < 1 || body.leverage > 20)) throw new Error('Leverage exceeds the market limit or 20x application cap');
    const intent: PaperIntent = { symbol, type: type as 'market' | 'limit', side: body.side, quantity: body.quantity,
      limitPrice: body.limitPrice ?? null, leverage: body.leverage ?? null, source, reason: body.reason ?? null };
    const prior = this.lifecycle.duplicate(body.id, intent);
    if (prior) return prior;
    if (this.busy || Date.now() - this.lastUse < 1000) throw new Error('Paper matcher busy; wait before next order');
    this.busy = true;
    const leverage = body.leverage ?? (this.store.get('paperLeverage') ?? {})[symbol] ?? 1;
    const order: any = { id: body.id, symbol, type, leverage, source, intent, generation: this.lifecycle.generation, phase: 'claimed', limitPrice: type === 'limit' ? body.limitPrice : undefined, side: body.side, quantity: body.quantity, time: new Date().toISOString(), status: 'pending', filled: 0 };
    let claimed = false;
    try {
      this.lifecycle.claim(order);
      claimed = true;
      const initial = await this.observe(symbol);
      if (this.stream) await this.settleFunding();
      this.store.db.transaction(() => this.prepare(order, initial)).immediate();
      const latency = this.store.get('paperSession').latencyMs;
      await Bun.sleep(latency);
      this.lifecycle.assertPending(order.id);
      if (this.stream) await this.settleFunding();
      const observation = this.stream || latency > 0 ? await this.observe(symbol) : initial;
      return this.store.db.transaction(() => {
        this.lifecycle.assertPending(order.id);
        if (Date.now() - Date.parse(observation.time) > 2000) throw new Error('Stale depth');
        const decimals = observation.market.supported_size_decimals;
        if (units(body.quantity, decimals) < units(observation.market.min_base_amount, decimals)) throw new Error('Quantity violates venue precision/minimum');
        const balance = this.balance();
        if (type === 'limit') units(body.limitPrice, observation.market.supported_price_decimals);
        const requested = units(body.quantity, 8), held = balance.inventory.get(`${symbol}-USD`)?.quantity ?? 0n, reducing = positionEffect(body.side, requested, held) === 'reduce';
        if (order.effect !== (reducing ? 'reduce' : 'open') || (source !== 'manual' && !reducing)) throw new Error('Position effect changed during latency');
        const leverage = order.leverage;
        if (!Number.isInteger(leverage) || leverage < 1 || leverage > (reducing ? 20 : leverageLimit(observation.market))) throw new Error('Leverage exceeds the market limit or 20x application cap');
        if (!reducing && held && balance.inventory.get(`${symbol}-USD`)!.leverage !== leverage) throw new Error('Close the position before changing leverage');
        if (!reducing && this.stream && (!this.metadataRead || performance.now() - this.metadataRead > 120000)) throw new Error('Fresh venue margin metadata required');
        if (!reducing && (observation.market.is_frozen || observation.market.market_config?.force_reduce_only)) throw new Error('Market is frozen or reduce-only');
        const minQuote = Number(observation.market.min_quote_amount);
        if (!Number.isFinite(minQuote) || minQuote < 0) throw new Error('Invalid venue minimum quote amount');
        if (markedMicros(requested, body.side === 'buy' ? observation.asks[0].price : observation.bids[0].price) < units(observation.market.min_quote_amount, 6)) throw new Error(`Quantity violates venue minimum quote amount: order must be worth at least $${minQuote}. Increase ${symbol} quantity using the current ${body.side === 'buy' ? 'ask' : 'bid'} price.`);
        const session = this.store.get('paperSession'), risk = this.store.get('risk');
        if (!reducing && (!session.enabled || this.store.get('halted') || this.store.get('paperLossHalt') || this.store.get('executionLossHalt'))) throw new Error('Paper activation required or risk halt latched');
        if (!reducing && this.store.get('paperLiquidityUnreconciled')) throw new Error('Historical liquidity cannot be reconciled; exposure increases disabled');
        if (!reducing && this.store.get('paperRecoveryHalt')) throw new Error('Paper recovery reconciliation required; exposure increases disabled');
        if (!reducing && this.riskDays.status().blocked) throw new Error('Paper baseline reconciliation required; exposure increases disabled');
        if (!reducing && this.store.get('paperFundingState')?.blocked) throw new Error('Funding reconciliation required; exposure increases disabled');
        if (!reducing && !['healthy', 'unknown'].includes(this.marginState().state)) throw new Error('Paper margin requires reductions; exposure increases disabled');
        if (!reducing && (this.store.db.query('SELECT COUNT(*) AS n FROM risk_reservations').get() as any).n > 0) throw new Error('Unresolved shared risk reservations');
        const rawLevels = (body.side === 'buy' ? observation.asks : observation.bids).filter(l => type !== 'limit' || (body.side === 'buy' ? l.price <= body.limitPrice : l.price >= body.limitPrice));
        if (!rawLevels.length) { const result = { ...order, status: 'canceled', canceled: body.quantity, observationId: observation.id }; return this.lifecycle.finish(result); }
        const liquidityKey = (price: number) => `${observation.market.market_id}:${body.side}:${price}`;
        // Public depth (even a new nonce) does not prove replenishment of our
        // simulated fill. Consumption stays fenced by side/price across restart.
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
        if (!levels.length) throw new Error('No unused Lighter liquidity; verified replenishment required');
        const matched = matchIOC(body.side, body.quantity, levels, decimals, observation.market.supported_price_decimals, session.feeBps);
        const { filled, cost, fee } = matched;
        const allocation = this.store.get('allocationPct') ?? 0;
        if (!Number.isInteger(allocation) || allocation < 0 || allocation > 100) throw new Error('Invalid allocation policy');
        const quote = BigInt(matched.quoteMicros), margin = (quote + BigInt(leverage) - 1n) / BigInt(leverage), charge = margin + BigInt(matched.feeMicros);
        if (!reducing) {
          const { exposure: heldValue, equity } = this.portfolio(balance);
          const fail = (message: string) => { throw new Error(`Paper risk limit: ${message}`); };
          if (allocation === 0) fail('allocation is 0%. Set and save a paper allocation in the order ticket before buying.');
          if (quote > units(risk.maxOrderNotional, 6) || markedMicros(requested, levels[0].price) > units(risk.maxOrderNotional, 6)) fail(`order exceeds the $${risk.maxOrderNotional} per-order cap. Reduce ${symbol} quantity.`);
          if (charge > balance.cash) fail(`initial margin plus fees exceeds $${(Number(balance.cash) / 1e6).toFixed(2)} available cash.`);
          if (heldValue + quote > units(risk.maxGrossNotional, 6)) fail(`total exposure exceeds the $${risk.maxGrossNotional} account cap.`);
          const usedMargin = [...balance.inventory.values()].reduce((sum, p) => sum + p.margin, 0n);
          if (usedMargin + charge > equity * BigInt(allocation) / 100n) fail(`all existing position margins plus new margin and fees exceed your ${allocation}% allocation. Reduce quantity or review allocation.`);
        }
        this.lifecycle.assertBudget(order.id, reducing ? 0n : quote, reducing ? 0n : charge);
        if (!filled) throw new Error('No executable depth');
        const fill: Fill = { id: body.id, account, botId: 'orion', symbol: `${symbol}-USD`, side: body.side, quantity: filled, price: cost / filled, fee, multiplier: 1, source: 'paper', reason: `Manual ${type} IOC${body.reason === 'stop-loss' || body.reason === 'take-profit' ? ` / ${body.reason}` : ''}; mainnet ${this.stream ? 'validated WebSocket' : 'REST'} depth ${observation.id}; simulated, not venue execution`, time: new Date().toISOString() };
        fill.settlement = { version: 2, effect: reducing ? 'reduce' : 'open', quantityAtoms: units(filled, 8).toString(), quoteMicros: matched.quoteMicros, feeMicros: matched.feeMicros, leverage: reducing ? balance.inventory.get(`${symbol}-USD`)!.leverage : leverage,
          ...(source === 'liquidation' ? { liquidationFeeMicros: ((quote + 99n) / 100n).toString() } : {}) };
        if (source === 'protection') fill.reason = fill.reason.replace(/^Manual /, 'Protection ');
        if (source === 'liquidation') fill.reason = 'Approximate paper liquidation / depth IOC / 1% notional surcharge; not venue LLP or ADL';
        const next = paperBalance([...this.fills(), fill], session.capital, readPaperEvents(this.store));
        if (!reducing && paperMargin(next, this.marks(), this.store.get('paperMarkets') ?? []).state !== 'healthy') throw new Error('Post-fill initial margin requirement not met');
        for (const leg of matched.executions) {
          const key = liquidityKey(leg.price), row = this.store.db.query('SELECT consumed FROM paper_liquidity WHERE key=?').get(key) as { consumed: string } | null;
          this.store.db.query('INSERT OR REPLACE INTO paper_liquidity VALUES (?,?)').run(key, (BigInt(row?.consumed ?? '0') + units(leg.quantity, 8)).toString());
        }
        this.store.db.query('INSERT INTO fills VALUES (?,?,?,?)').run(account, fill.id, fill.time, JSON.stringify(fill));
        this.checkLoss(fill.time.slice(0, 10));
        if (!this.summary().positions.some(p => p.symbol === `${symbol}-USD`)) {
          const protections = this.store.get('paperProtections') ?? {}; delete protections[symbol]; this.store.set('paperProtections', protections);
        }
        const result = { ...order, ...matched, status: matched.canceled === 0 ? 'filled' : 'partial-canceled', observationId: observation.id };
        if (source === 'liquidation') result.liquidationFeeMicros = fill.settlement.liquidationFeeMicros;
        this.store.audit('MAINNET_PAPER_FILL', JSON.stringify(result));
        return this.lifecycle.finish(result);
      }).immediate();
    } catch (e) {
      const current = claimed ? this.lifecycle.get(order.id) : null;
      if (current && current.status !== 'pending') return current;
      const result = { ...order, status: 'rejected', error: (e as Error).message };
      if (claimed && this.lifecycle.active()) return this.lifecycle.finish(result);
      return result;
    }
    finally { this.busy = false; this.lastUse = Date.now(); }
  }
}