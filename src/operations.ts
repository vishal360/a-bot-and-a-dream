import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from './store';
import type { Vault } from './vault';
import { analytics, validateFill, type Fill, type Mark } from './ledger';
import type { Bot } from './domain';
import { paperAnalytics } from './paper-ledger';
import { units } from './paper-math';
export type Connection = { id: string; name: string; provider: 'alpaca-paper' | 'alpaca-live' | 'binance'; botId: string; symbol: string; secret: string; status: string; lastSync: string | null; account: any };
export const policyDefaults = { capital: 100000, maxOrderNotional: 40000, maxGrossNotional: 90000, dailyLoss: 1000, feeBps: 2, slippageBps: 2, tickSeconds: 3 };
export class Operations {
  allocationPolicy() {
    return { allocationPct: this.store.get('allocationPct') ?? 0, dailyLossPct: 6, maxLeverage: 20, executionEnabled: false };
  }
  allocationPreview(now = Date.now()) {
    const policy = this.allocationPolicy(), config = this.lighterConfig(), account = this.store.get('lighterAccount');
    const base = { ...policy, equity: null, marginBudget: null, snapshotTime: account?.time ?? null, network: config?.network ?? null, accountIndex: config?.accountIndex ?? null };
    if (!config || !account) return { ...base, status: 'unavailable', reason: 'Save a Lighter connection and read its account from the venue.' };
    if (account.network !== config.network || account.accountIndex !== config.accountIndex) return { ...base, status: 'unavailable', reason: 'Account snapshot does not match the configured account. Refresh it.' };
    const age = now - Date.parse(account.time);
    if (!Number.isFinite(age) || age < 0 || age > 30000) return { ...base, status: 'stale', reason: 'Account snapshot is older than 30 seconds or has an invalid timestamp. Refresh it.' };
    const raw = account.totalAssetValue;
    const equity = typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    if (!Number.isFinite(equity) || equity < 0) return { ...base, status: 'unavailable', reason: 'Venue total asset value is missing or invalid; no example-balance fallback is used.' };
    return { ...base, equity, marginBudget: equity * policy.allocationPct / 100, status: 'public-snapshot', reason: 'Reported total asset value is not authenticated or reconciled execution equity.' };
  }
  saveAllocation(body: any) {
    if (typeof body.allocationPct !== 'number' || !Number.isInteger(body.allocationPct) || body.allocationPct < 0 || body.allocationPct > 100) throw new Error('Allocation must be a whole percentage from 0 to 100');
    this.store.set('allocationPct', body.allocationPct);
    this.store.audit('SAVE_ALLOCATION', `${body.allocationPct}% aggregate margin budget; execution remains disabled`);
    return this.allocationPolicy();
  }
  constructor(public store: Store, private vault: Vault, private request: typeof fetch = fetch) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS fills (account TEXT NOT NULL,id TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
    if (!store.get('risk')) store.set('risk', policyDefaults);
    if (!store.get('marks')) store.set('marks', []);
    if (!store.get('feed')) store.set('feed', { sequence: 0, prices: { MES: 5200, 'BTC-USD': 65000 }, history: [], mode: 'synthetic', lastTick: null });
    if (!store.get('ingestionHash')) this.rotateToken();
  }
  fills(): Fill[] { return this.store.db.query('SELECT payload FROM fills ORDER BY time,rowid').all().map((r: any) => JSON.parse(r.payload)); }
  archives() {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS ledger_archives (id TEXT PRIMARY KEY,time TEXT NOT NULL,payload TEXT NOT NULL)');
    return this.store.db.query('SELECT id,time FROM ledger_archives ORDER BY time DESC').all() as { id: string; time: string }[];
  }
  archive(id: string) {
    this.archives();
    const row = this.store.db.query('SELECT payload FROM ledger_archives WHERE id=?').get(id) as { payload: string } | null;
    if (!row) throw new Error('Unknown archive');
    return JSON.parse(row.payload);
  }
  resetStats(confirm: string) {
    if (confirm !== 'ARCHIVE AND RESET') throw new Error('Explicit ARCHIVE AND RESET confirmation required');
    this.archives();
    return this.store.db.transaction(() => {
      const fills = this.fills(), marks = this.store.get('marks');
      if (fills.some(f => f.account === 'paper-mainnet')) throw new Error('Reset blocked: mainnet paper session ledger must be retained for cash and loss-baseline continuity. Separate session archival is not implemented.');
      for (const account of new Set(fills.map(f => f.account))) {
        if (analytics(fills.filter(f => f.account === account), marks, 0).positions.length) throw new Error('Reset blocked: recorded open positions must reconcile to flat first. Reset never closes venue positions.');
      }
      const id = crypto.randomUUID(), time = new Date().toISOString();
      const payload = { ...this.snapshot(), fills, bots: this.store.get('bots'), marks, time, id };
      this.store.db.query('INSERT INTO ledger_archives VALUES (?,?,?)').run(id, time, JSON.stringify(payload));
      this.store.db.exec('DELETE FROM fills');
      this.store.set('marks', []); this.store.set('alerts', []); this.store.set('heartbeats', {});
      const feed = this.store.get('feed'); this.store.set('feed', { ...feed, sequence: 0, history: [], lastTick: null });
      this.store.set('bots', (this.store.get('bots') as Bot[]).map(b => ({ ...b, status: this.store.get('halted') ? 'halted' : 'paused' })));
      this.store.audit('ARCHIVE_RESET_STATS', `${id}: local execution ledger archived; credentials, research, risk and halt preserved; venue untouched`);
      return { id, time };
    })();
  }
  connections(): Connection[] { return this.store.db.query('SELECT payload FROM connections').all().map((r: any) => JSON.parse(r.payload)); }
  putConnection(c: Connection) { this.store.db.query('INSERT OR REPLACE INTO connections VALUES (?,?)').run(c.id, JSON.stringify(c)); }
  snapshot() {
    const fills = this.fills(), risk = this.store.get('risk'), marks = this.store.get('marks') as Mark[];
    const accounts = [...new Set(['paper', 'paper-mainnet', ...fills.map(f => f.account)])].map(account => ({ account, source: account === 'paper-mainnet' ? 'local mainnet-depth paper / long-only 1x / no funding' : account === 'paper' ? 'legacy synthetic-paper (disabled)' : 'imported / history may be incomplete', analytics: account === 'paper-mainnet' ? paperAnalytics(fills.filter(f => f.account === account), marks, this.store.get('paperSession')?.capital ?? 10000) : analytics(fills.filter(f => f.account === account), marks, account === 'paper' ? risk.capital : 0) }));
    return { accounts, fills: fills.slice(-1000).reverse(), feed: this.store.get('feed'), risk, connections: this.connections().map(({ secret, ...c }) => c), heartbeats: this.store.get('heartbeats') || {}, alerts: this.store.get('alerts') || [], ingestionEnabled: true };
  }
  rotateToken() { const token = randomBytes(32).toString('hex'); this.store.set('ingestionHash', new Bun.CryptoHasher('sha256').update(token).digest('hex')); this.store.audit('ROTATE_INGESTION_TOKEN', 'Old ingestion token revoked'); return token; }
  authorized(token: string) { const hash = new Bun.CryptoHasher('sha256').update(token).digest('hex'); return timingSafeEqual(Buffer.from(hash), Buffer.from(this.store.get('ingestionHash'))); }
  ingest(f: Fill) {
    validateFill(f);
    if (!(this.store.get('bots') as Bot[]).some(b => b.id === f.botId)) throw new Error('Register the bot before importing its fills');
    if (f.source === 'imported' && ['paper', 'paper-mainnet'].includes(f.account)) throw new Error('Imported fills cannot enter a local paper account');
    const normalized = { ...f, time: new Date(f.time).toISOString() };
    for (const a of this.archives()) {
      const old = (this.archive(a.id).fills as Fill[]).find(x => x.account === f.account && x.id === f.id);
      if (old) { if (JSON.stringify(old) !== JSON.stringify(normalized)) throw new Error('Conflicting archived duplicate fill'); return false; }
    }
    return this.store.db.transaction(() => {
      const old = this.store.db.query('SELECT payload FROM fills WHERE account=? AND id=?').get(f.account, f.id) as { payload: string } | null;
      if (old) { if (old.payload !== JSON.stringify(normalized)) throw new Error('Conflicting duplicate fill'); return false; }
      const prior = this.fills().filter(x => x.account === f.account && x.symbol === f.symbol);
      if (prior.some(x => x.multiplier !== f.multiplier)) throw new Error('Contract multiplier mismatch');
      this.store.db.query('INSERT INTO fills VALUES (?,?,?,?)').run(f.account, f.id, normalized.time, JSON.stringify(normalized));
      this.store.audit('FILL', `${f.source}: ${f.botId} ${f.side} ${f.quantity} ${f.symbol} @ ${f.price}`); return true;
    })();
  }
  heartbeat(body: any) {
    if (!(this.store.get('bots') as Bot[]).some(b => b.id === body.botId)) throw new Error('Unknown bot');
    const beats = this.store.get('heartbeats') || {}; beats[body.botId] = { time: new Date().toISOString(), message: String(body.message || '').slice(0, 240) }; this.store.set('heartbeats', beats);
  }
  addBot(body: any) {
    const bots = this.store.get('bots') as Bot[];
    if (!/^[a-z0-9-]{2,40}$/.test(body.id) || bots.some(b => b.id === body.id) || !['futures', 'crypto'].includes(body.asset) || !['MES', 'BTC-USD'].includes(body.symbol) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw new Error('Invalid bot. Unique lowercase ID; supported symbols MES/BTC-USD.');
    if ((body.symbol === 'MES') !== (body.asset === 'futures')) throw new Error('Instrument and asset class mismatch');
    bots.push({ id: body.id, name: body.name, symbol: body.symbol, asset: body.asset, status: 'paused', createdAt: new Date().toISOString(), strategy: 'Paper trend reversal', description: 'Custom runner / external fill attribution' }); this.store.set('bots', bots); this.store.audit('ADD_BOT', body.id);
  }
  risk(body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !(key in policyDefaults))) throw new Error('Unknown risk policy field');
    const r = { ...this.store.get('risk'), ...body };
    for (const [key, min, max] of [['capital', 100, 1e8], ['maxOrderNotional', 10, 1e8], ['maxGrossNotional', 10, 1e8], ['dailyLoss', 1, 1e7], ['feeBps', 0, 100], ['slippageBps', 0, 100], ['tickSeconds', 1, 60]] as const) if (!Number.isFinite(r[key]) || r[key] < min || r[key] > max) throw new Error(`Invalid ${key}`);
    for (const key of ['capital', 'maxOrderNotional', 'maxGrossNotional', 'dailyLoss'] as const) units(r[key], 6);
    if (r.capital !== this.store.get('risk').capital && this.fills().some(f => f.account === 'paper')) throw new Error('Initial capital cannot change after paper fills');
    this.store.set('risk', r); this.store.audit('RISK_POLICY', JSON.stringify(r));
  }
  mark(mark: Mark) {
    if (!Number.isFinite(mark.price) || mark.price <= 0 || !Number.isFinite(Date.parse(mark.time)) || Date.parse(mark.time) > Date.now() + 60000 || typeof mark.symbol !== 'string' || !mark.symbol.trim() || mark.symbol.length > 180 || typeof mark.account !== 'string' || !mark.account.trim() || mark.account.length > 180 || mark.source === 'synthetic' && mark.account !== 'paper') throw new Error('Invalid mark');
    const marks = this.store.get('marks') as Mark[], previous = marks.find(m => m.account === mark.account && m.symbol === mark.symbol);
    if (previous && Date.parse(mark.time) < Date.parse(previous.time)) throw new Error('Mark timestamp moved backwards');
    this.store.set('marks', [...marks.filter(m => !(m.account === mark.account && m.symbol === mark.symbol)), mark]);
  }
  paperOrder(body: { botId: string; side: 'buy' | 'sell'; quantity: number; reason?: string }, reducingOnly = false) {
    const bot = (this.store.get('bots') as Bot[]).find(b => b.id === body.botId); if (!bot) throw new Error('Unknown bot');
    const r = this.store.get('risk'), feed = this.store.get('feed'), marks = this.store.get('marks') as Mark[];
    const summary = analytics(this.fills().filter(f => f.account === 'paper'), marks, r.capital);
    const p = summary.positions.find(p => p.botId === bot.id && p.symbol === bot.symbol), signed = body.side === 'buy' ? body.quantity : -body.quantity;
    const reducing = !!p && Math.sign(signed) !== Math.sign(p.quantity) && body.quantity <= Math.abs(p.quantity) + 1e-10;
    if (reducingOnly && !reducing) throw new Error('Flatten cannot increase exposure');
    if (!reducing && (this.store.get('halted') || bot.status !== 'running')) throw new Error('Runner paused or halt latched');
    if (!feed.lastTick || Date.now() - Date.parse(feed.lastTick) > 15000) throw new Error('Paper feed stale; wait for the next tick');
    const multiplier = bot.asset === 'futures' ? 5 : 1;
    if (!['buy', 'sell'].includes(body.side) || !Number.isFinite(body.quantity) || body.quantity <= 0 || bot.asset === 'futures' && !Number.isInteger(body.quantity)) throw new Error('Invalid order quantity or side');
    const price = feed.prices[bot.symbol] * (1 + (body.side === 'buy' ? 1 : -1) * r.slippageBps / 10000);
    const notional = price * body.quantity * multiplier;
    const gross = summary.positions.reduce((s, p) => s + Math.abs(p.quantity) * (p.mark ?? p.average) * p.multiplier, 0);
    const nextGross = gross - (p ? Math.abs(p.quantity) * (p.mark ?? p.average) * multiplier : 0) + Math.abs((p?.quantity || 0) + signed) * price * multiplier;
    if (!reducing && (notional > r.maxOrderNotional || nextGross > Math.min(r.maxGrossNotional, summary.equity ?? 0) || summary.today <= -r.dailyLoss)) throw new Error('Order exceeds account risk limits');
    const fill: Fill = { id: crypto.randomUUID(), account: 'paper', botId: bot.id, symbol: bot.symbol, side: body.side, quantity: body.quantity, price, multiplier, fee: notional * r.feeBps / 10000, time: new Date().toISOString(), source: 'paper', reason: body.reason || 'manual paper order' };
    this.ingest(fill); return fill;
  }
  flatten(botId?: string) {
    const positions = analytics(this.fills().filter(f => f.account === 'paper'), this.store.get('marks'), this.store.get('risk').capital).positions;
    const fills = positions.filter(p => !botId || p.botId === botId).map(p => this.paperOrder({ botId: p.botId, side: p.quantity > 0 ? 'sell' : 'buy', quantity: Math.abs(p.quantity), reason: 'operator flatten' }, true));
    this.store.audit('PAPER_FLATTEN', `${fills.length} positions closed. External broker positions untouched.`); return fills;
  }
  tick() {
    const feed = this.store.get('feed'), now = new Date().toISOString(), risk = this.store.get('risk');
    feed.sequence++;
    for (const symbol of ['MES', 'BTC-USD']) {
      const phase = feed.sequence / (symbol === 'MES' ? 8 : 11);
      feed.prices[symbol] *= 1 + Math.sin(phase) * (symbol === 'MES' ? .0005 : .0015);
      this.mark({ account: 'paper', symbol, price: feed.prices[symbol], time: now, source: 'synthetic' });
    }
    feed.lastTick = now; feed.history.push({ time: now, ...feed.prices }); feed.history = feed.history.slice(-600); this.store.set('feed', feed);
    const account = analytics(this.fills().filter(f => f.account === 'paper'), this.store.get('marks'), risk.capital);
    if (account.today <= -risk.dailyLoss && !this.store.get('halted')) { this.store.halt(); this.alert('critical', 'Daily paper loss limit reached; halt latched. Positions remain open: flatten explicitly.'); }
    for (const bot of this.store.get('bots') as Bot[]) {
      if (bot.status !== 'running') continue;
      this.heartbeat({ botId: bot.id, message: 'Synthetic paper strategy tick' });
      const history = feed.history, index = history.length - 1; if (index < 6 || feed.sequence % 3) continue;
      const momentum = history[index][bot.symbol] - history[index - 5][bot.symbol];
      const position = account.positions.find(p => p.botId === bot.id);
      try {
        if (position && momentum < 0) this.paperOrder({ botId: bot.id, side: position.quantity > 0 ? 'sell' : 'buy', quantity: Math.abs(position.quantity), reason: 'paper momentum exit' }, true);
        else if (!position && momentum > 0) this.paperOrder({ botId: bot.id, side: 'buy', quantity: bot.asset === 'futures' ? 1 : .05, reason: 'paper momentum entry' });
      } catch (e) { this.store.audit('ORDER_BLOCKED', `${bot.id}: ${(e as Error).message}`); }
    }
  }
  alert(severity: string, message: string) { const a = this.store.get('alerts') || []; a.unshift({ id: crypto.randomUUID(), severity, message, time: new Date().toISOString(), acknowledged: false }); this.store.set('alerts', a.slice(0, 100)); }
  acknowledge(id: string) { const a = this.store.get('alerts') || []; const item = a.find((a: any) => a.id === id); if (!item) throw new Error('Unknown alert'); item.acknowledged = true; this.store.set('alerts', a); }
  saveConnection(body: any) {
    if (!['alpaca-paper', 'alpaca-live', 'binance'].includes(body.provider) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60 || typeof body.apiKey !== 'string' || !body.apiKey || typeof body.apiSecret !== 'string' || !body.apiSecret || body.apiKey.length > 500 || body.apiSecret.length > 500 || !(this.store.get('bots') as Bot[]).some(b => b.id === body.botId)) throw new Error('Invalid connection fields');
    if (body.provider === 'binance' && !/^[A-Z0-9]{5,20}$/.test(body.symbol)) throw new Error('Binance requires an explicit symbol such as BTCUSDT');
    const id = crypto.randomUUID(); this.putConnection({ id, name: body.name, provider: body.provider, botId: body.botId, symbol: body.symbol || 'BTCUSDT', secret: this.vault.encrypt({ apiKey: body.apiKey, apiSecret: body.apiSecret }), status: 'saved / not tested', lastSync: null, account: null }); this.store.audit('SAVE_CONNECTION', `${body.provider}: ${body.name} (read-only adapter)`); return id;
  }
  removeConnection(id: string) { this.store.db.query('DELETE FROM connections WHERE id=?').run(id); this.store.audit('DELETE_CONNECTION', id); }
  saveLighter(body: any) {
    if (!['testnet', 'mainnet'].includes(body.network) || !Number.isSafeInteger(body.accountIndex) || body.accountIndex < 0 || !Number.isInteger(body.apiKeyIndex) || body.apiKeyIndex < 0 || body.apiKeyIndex > 255 || typeof body.privateKey !== 'string' || !/^(0x)?[a-fA-F0-9]{80}$/.test(body.privateKey)) throw new Error('Provide network, account index, API-key index and an 80-hex-character Lighter API private key');
    this.store.set('lighterConfig', { network: body.network, accountIndex: body.accountIndex, apiKeyIndex: body.apiKeyIndex, secret: this.vault.encrypt({ privateKey: body.privateKey }) });
    this.store.set('lighterAccount', null);
    this.store.audit('LIGHTER_CONFIG', `${body.network}: encrypted credentials saved; signing not enabled`);
  }
  lighterConfig() { const config = this.store.get('lighterConfig'); if (!config) return null; const { secret, ...safe } = config; return { ...safe, hasKey: !!secret, executionEnabled: false }; }
  deleteLighter() { this.store.set('lighterConfig', null); this.store.set('lighterAccount', null); this.store.audit('LIGHTER_DELETE', 'Credentials removed'); }
  async syncLighter() {
    const config = this.lighterConfig(); if (!config) throw new Error('Save connection settings first');
    const host = config.network === 'testnet' ? 'https://testnet.zklighter.elliot.ai' : 'https://mainnet.zklighter.elliot.ai';
    const result = await this.get(`${host}/api/v1/account?by=index&value=${config.accountIndex}`, {});
    if (result.code !== 200 || !Array.isArray(result.accounts) || !result.accounts.length) throw new Error('Account not found on selected network');
    const a = result.accounts.find((a: any) => Number(a.account_index ?? a.index) === config.accountIndex);
    if (!a) throw new Error('Venue account index mismatch');
    const current = this.lighterConfig();
    if (!current || current.network !== config.network || current.accountIndex !== config.accountIndex || current.apiKeyIndex !== config.apiKeyIndex) throw new Error('Connection changed during account read; refresh the selected account');
    const snapshot = { network: config.network, accountIndex: config.accountIndex, time: new Date().toISOString(), collateral: a.collateral, availableBalance: a.available_balance, totalAssetValue: a.total_asset_value, positions: a.positions, status: 'Public account read verified; private-key authentication NOT verified' };
    this.store.set('lighterAccount', snapshot); return snapshot;
  }
  private async get(url: string, headers: Record<string, string>) {
    const response = await this.request(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Provider request failed (${response.status}); check key permissions, environment, region and rate limits.`);
    return response.json();
  }
  async sync(id: string) {
    const c = this.connections().find(c => c.id === id); if (!c) throw new Error('Unknown connection');
    const credentials = this.vault.decrypt(c.secret), accountId = `connection:${c.id}`;
    try {
      if (c.provider.startsWith('alpaca')) {
        const base = c.provider === 'alpaca-paper' ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
        const headers = { 'APCA-API-KEY-ID': credentials.apiKey, 'APCA-API-SECRET-KEY': credentials.apiSecret };
        const account = await this.get(base + '/v2/account', headers);
        c.account = { equity: account.equity, cash: account.cash, buyingPower: account.buying_power, status: account.status, currency: account.currency };
        // Fetch all fill activity pages. Do not silently turn a truncated first page into full history.
        let token = '', pages = 0;
        while (true) {
          const url = base + '/v2/account/activities/FILL?direction=asc&page_size=100' + (token ? '&page_token=' + encodeURIComponent(token) : '');
          const activities = await this.get(url, headers); if (!Array.isArray(activities)) throw new Error('Invalid fill response');
          for (const a of activities) this.ingest({ id: a.id, account: accountId, botId: c.botId, symbol: a.symbol, side: a.side, quantity: Number(a.qty), price: Number(a.price), multiplier: 1, fee: 0, time: a.transaction_time, source: 'imported', reason: 'Alpaca fill; fees not provided by FILL activity' });
          if (activities.length < 100) break;
          const next = activities.at(-1).id; if (next === token || ++pages >= 100) throw new Error('History pagination incomplete; imported fills retained, do not assume full history'); token = next;
        }
        const positions = await this.get(base + '/v2/positions', headers);
        if (!Array.isArray(positions)) throw new Error('Invalid positions response');
        c.account.positions = positions.map((p: any) => ({ symbol: p.symbol, qty: p.qty, average: p.avg_entry_price, unrealized: p.unrealized_pl, marketValue: p.market_value }));
        for (const p of positions) this.mark({ account: accountId, symbol: p.symbol, price: Number(p.current_price), time: new Date().toISOString(), source: c.provider });
      } else {
        const signed = (path: string, params: Record<string, string> = {}) => {
          const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' }).toString();
          return this.get(`https://api.binance.com${path}?${q}&signature=${createHmac('sha256', credentials.apiSecret).update(q).digest('hex')}`, { 'X-MBX-APIKEY': credentials.apiKey });
        };
        const account = await signed('/api/v3/account'); c.account = { canTrade: account.canTrade, balances: account.balances?.filter((b: any) => Number(b.free) + Number(b.locked) > 0), currency: 'quote asset; not USD normalized' };
        // Imported Binance fees must be in the pair quote currency to avoid false net P&L.
        const info = await this.get(`https://api.binance.com/api/v3/exchangeInfo?symbol=${c.symbol}`, {}); const quote = info.symbols?.[0]?.quoteAsset;
        let fromId = '0', pages = 0;
        while (true) {
          const trades = await signed('/api/v3/myTrades', { symbol: c.symbol, limit: '1000', fromId }); if (!Array.isArray(trades)) throw new Error('Invalid trade response');
          for (const t of trades) {
            if (Number(t.commission) && t.commissionAsset !== quote) throw new Error(`Fee asset ${t.commissionAsset} requires conversion; sync stopped rather than invent net P&L`);
            this.ingest({ id: `${c.symbol}:${t.id}`, account: accountId, botId: c.botId, symbol: c.symbol, side: t.isBuyer ? 'buy' : 'sell', quantity: Number(t.qty), price: Number(t.price), multiplier: 1, fee: Number(t.commission), time: new Date(t.time).toISOString(), source: 'imported', reason: `Binance spot fill; P&L denominated in ${quote}` });
          }
          if (trades.length < 1000) break; if (++pages >= 100) throw new Error('History pagination incomplete'); fromId = String(BigInt(trades.at(-1).id) + 1n);
        }
        const ticker = await this.get(`https://api.binance.com/api/v3/ticker/price?symbol=${c.symbol}`, {});
        this.mark({ account: accountId, symbol: c.symbol, price: Number(ticker.price), time: new Date().toISOString(), source: 'binance' });
      }
      c.status = 'connected / read-only'; c.lastSync = new Date().toISOString(); this.putConnection(c); this.store.audit('SYNC_CONNECTION', `${c.provider}: complete`); return c.status;
    } catch (e) { c.status = (e as Error).message; this.putConnection(c); this.alert('warning', `${c.name}: ${c.status}`); throw e; }
  }
}