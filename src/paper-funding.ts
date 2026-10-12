import type { Store } from './store';
import type { Fill } from './ledger';
import { HOUR_MS, fundingPayment, paperBalance, type FundingEvent, type LedgerEvents } from './paper-ledger';
import { units } from './paper-math';

const hash = (value: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
export function readPaperEvents(store: Store): LedgerEvents {
  const exists = store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_funding'").get();
  if (!exists) return { funding: [] };
  const funding = store.db.query('SELECT market_id,timestamp,payload FROM paper_funding ORDER BY timestamp,market_id').all().map((r: any) => {
    const event = JSON.parse(r.payload) as FundingEvent;
    if (event.marketId !== r.market_id || event.timestamp !== r.timestamp) throw new Error('Funding storage identity mismatch');
    return event;
  });
  for (const event of funding) {
    const { sha256, ...content } = event;
    const raw = event.raw as any;
    if (sha256 !== hash(content) || event.id !== `${event.marketId}:${event.timestamp}` || !Number.isSafeInteger(event.marketId) || event.marketId < 0 ||
        event.source !== 'lighter-mainnet-fundings-1h' || raw?.timestamp !== event.timestamp || raw?.value !== event.valuePerUnit ||
        raw?.rate !== event.rate || raw?.direction !== event.direction || !Number.isFinite(Date.parse(event.recordedAt)) ||
        Date.parse(event.recordedAt) < Date.parse(event.time) + HOUR_MS) throw new Error('Invalid immutable funding evidence');
  }
  return { funding };
}

/** Delayed history reconciliation. Current-hour history is NEVER treated as final. */
export class PaperFunding {
  private busy = false;
  private attempt = -Infinity;
  constructor(private store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS paper_funding (market_id INTEGER NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(market_id,timestamp))');
    try { readPaperEvents(store); }
    catch (error) { store.set('paperFundingState', { blocked: true, error: (error as Error).message }); }
  }
  status() {
    return { ...this.store.get('paperFundingState'), policy: 'history timestamp / pre-boundary position; one-hour finality delay; venue ordering unverified',
      events: readPaperEvents(this.store).funding?.slice(-100).reverse() ?? [] };
  }
  async refresh(fills: Fill[], capital: number, markets: any[], get: (path: string) => Promise<any>, active: () => boolean, now = Date.now()) {
    if (!active()) throw new Error('Paper worker superseded by restart');
    if (this.busy) throw new Error('Funding reconciliation in progress');
    if (performance.now() - this.attempt < 30000) return;
    this.busy = true; this.attempt = performance.now();
    try {
      const latest = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
      const existing = readPaperEvents(this.store).funding ?? [];
      for (const symbol of new Set(fills.map(f => f.symbol))) {
        const market = markets.find(m => `${m.symbol}-USD` === symbol);
        const relevant = fills.filter(f => f.symbol === symbol).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        const first = Math.floor(Date.parse(relevant[0].time) / HOUR_MS) * HOUR_MS + HOUR_MS;
        if (first > latest) continue;
        // Bound catch-up work; never silently skip an old exposure window.
        const lastFill = relevant.reduce((ms, f) => Math.max(ms, Date.parse(f.time)), 0);
        const flat = !paperBalance(fills, capital, { funding: existing }).inventory.get(symbol)?.quantity;
        const end = flat ? Math.min(latest, Math.floor(lastFill / HOUR_MS) * HOUR_MS) : latest;
        const due: { ms: number; held: bigint }[] = [];
        const settled = new Map(existing.filter(e => e.symbol === symbol).map(e => [e.timestamp * 1000, e]));
        let cursor = 0, held = 0n;
        for (let ms = first; ms <= end; ms += HOUR_MS) {
          while (cursor < relevant.length && Date.parse(relevant[cursor].time) < ms) {
            const f = relevant[cursor++]; held += (f.side === 'buy' ? 1n : -1n) * units(f.quantity, 8);
          }
          const event = settled.get(ms);
          if (event && (event.positionAtoms !== held.toString() || event.marketId !== market?.market_id)) throw new Error('Funding market or historical position mismatch');
          if (held && !event) {
            if ((latest - ms) / HOUR_MS >= 720) throw new Error('Funding history exceeds the 720-hour reconciliation window; offline review required');
            due.push({ ms, held });
          }
          // Jump flat periods without inferring that a nonzero hour was settled.
          if (!held && cursor < relevant.length) ms = Math.max(ms, Math.floor(Date.parse(relevant[cursor].time) / HOUR_MS) * HOUR_MS);
        }
        if (!due.length) continue;
        if (!market || !Number.isSafeInteger(market.market_id)) throw new Error(`Funding market identity unavailable: ${symbol}`);
        const body = await get(`/api/v1/fundings?market_id=${market.market_id}&resolution=1h&start_timestamp=${Math.floor(due[0].ms / 1000) - 3600}&end_timestamp=${Math.floor(end / 1000) + 3600}&count_back=0`);
        if (!active()) throw new Error('Paper worker superseded by restart');
        if (body.code !== 200 || body.resolution !== '1h' || !Array.isArray(body.fundings)) throw new Error('Invalid funding history');
        const rows = new Map<number, any>();
        for (const row of body.fundings) {
          if (!Number.isSafeInteger(row.timestamp) || row.timestamp % 3600 !== 0 || rows.has(row.timestamp) ||
              typeof row.rate !== 'string' || typeof row.value !== 'string' || !['long', 'short'].includes(row.direction)) throw new Error('Invalid or duplicate funding hour');
          units(row.rate, 8); units(row.value, 8); rows.set(row.timestamp, row);
        }
        const additions = due.map(({ ms, held }) => {
          const raw = rows.get(ms / 1000);
          if (!raw) throw new Error(`Missing funding hour: ${symbol} ${new Date(ms).toISOString()}`);
          const content: Omit<FundingEvent, 'sha256'> = { version: 1, id: `${market.market_id}:${raw.timestamp}`, symbol, marketId: market.market_id,
            timestamp: raw.timestamp, time: new Date(ms).toISOString(), rate: raw.rate, direction: raw.direction, valuePerUnit: raw.value,
            positionAtoms: held.toString(), paymentMicros: fundingPayment(held, raw.value, raw.direction).toString(),
            source: 'lighter-mainnet-fundings-1h', raw, recordedAt: new Date(now).toISOString() };
          return { ...content, sha256: hash(content) };
        });
        this.store.db.transaction(() => {
          if (!active()) throw new Error('Paper worker superseded by restart');
          // Position eligibility is reconstructed from durable fills, never today's inventory.
          const all = [...(readPaperEvents(this.store).funding ?? []), ...additions];
          paperBalance(fills, capital, { funding: all });
          for (const event of additions) this.store.db.query('INSERT INTO paper_funding VALUES (?,?,?)').run(event.marketId, event.timestamp, JSON.stringify(event));
          this.store.audit('PAPER_FUNDING_SETTLED', `${symbol}: ${additions.length} delayed hourly records`);
        }).immediate();
        existing.push(...additions);
      }
      if (active()) this.store.set('paperFundingState', { blocked: false, error: null, checkedAt: new Date(now).toISOString() });
    } catch (error) {
      if (active()) this.store.set('paperFundingState', { blocked: true, error: (error as Error).message, checkedAt: new Date(now).toISOString() });
    } finally { this.busy = false; }
  }
}