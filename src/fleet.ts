import type { Store } from './store';
import type { FeedHealthGuard } from './feed-health';
import type { DecisionJournal } from './journal';
import type { StrategyRegistry } from './strategies/registry';
import { validateParams, midPrice, type StrategyContext, type StrategyProposal } from './strategies/types';
import type { PublicTrade } from './lighter-trades';
import { leverageLimit } from './paper';
import type { PromotionGate } from './promotion';

type PaperStatus = ReturnType<import('./paper').Paper['status']>;
export type PaperSubmitResult = { id: string; status: string; filled?: number; price?: number; error?: string };
export interface FleetPaper {
  status(): PaperStatus;
  botOrder(body: { id: string; symbol: string; side: 'buy' | 'sell'; quantity: number; leverage: number; botId: string; reason: string }): Promise<PaperSubmitResult>;
}
export interface FleetFeed {
  status(): Parameters<FeedHealthGuard['sample']>[0];
  read(marketId: number, limit?: number): { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[]; receivedAt?: string | null; stats?: { mark: number; index: number; fundingRate: number | null; last: number | null } | null } | null;
  evidence?: { recentTrades(marketId: number, limit?: number): PublicTrade[] } | null;
}

export type FleetBot = {
  id: string; name: string; strategyId: string; params: Record<string, number>; symbol: string; leverage: number;
  maxNotionalPerOrder: number; maxOpenNotional: number; maxOrdersPerHour: number; cooldownMs: number; maxDailyLossUsd: number;
  status: 'paused' | 'running' | 'halted'; createdAt: string;
  stats: { orders: number; fills: number; rejected: number; lastDecisionAt: string | null; lastError: string | null };
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SYMBOL = /^[A-Za-z0-9._/-]{1,80}$/;
const money = (v: unknown, key: string, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
  return v;
};
const floorTo = (value: number, decimals: number) => Math.floor(value * 10 ** decimals) / 10 ** decimals;

/** Multi-bot paper automation on the single shared paper authority. Bots propose; the
 *  executor disposes: every order goes through the same reservations, risk limits and
 *  halts as manual orders. Automation authorization never survives a restart. */
export class FleetManager {
  private bots: FleetBot[];
  private windows = new Map<string, { time: string; mid: number }[]>();
  private submitTimes = new Map<string, number[]>();
  private lastSubmitAt = new Map<string, number>();
  private openNotional = new Map<string, number>();
  private lastSkipJournal = new Map<string, number>();
  private tickBusy = false;
  private nowMono = 0;
  private submitBusy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGuardPersist = 0;

  constructor(private store: Store, private paper: FleetPaper, private feed: FleetFeed,
    private journal: DecisionJournal, private registry: StrategyRegistry, private guard: FeedHealthGuard,
    private hooks: { onWatchChange?: () => void } = {},
    private clock: { mono: () => number; wall: () => number } = { mono: () => performance.now(), wall: () => Date.now() },
    private promotion: PromotionGate | null = null) {
    this.bots = store.get('fleet') ?? [];
    for (const bot of this.bots) bot.status = 'paused'; // Restart never resumes a runner automatically.
    // Automation authorization is an operator action per session, never persisted trust.
    if (store.get('fleetEnabled')) { store.set('fleetEnabled', false); store.audit('FLEET_AUTOMATION_OFF', 'Restart cleared fleet automation authorization'); }
    this.rebuildOpenNotional();
    this.save();
  }

  private save() { this.store.set('fleet', this.bots); }
  private bot(id: string) { return this.bots.find(b => b.id === id); }

  private rebuildOpenNotional() {
    this.openNotional.clear();
    const rows = this.store.db.query(`SELECT payload FROM fills WHERE account='paper-mainnet' AND json_extract(payload,'$.botId') LIKE 'fleet-%'`).all() as { payload: string }[];
    for (const row of rows) {
      const fill = JSON.parse(row.payload);
      if (!fill.settlement) continue;
      const current = this.openNotional.get(fill.botId) ?? 0;
      this.openNotional.set(fill.botId, Math.max(0, current + (fill.settlement.effect === 'open' ? 1 : -1) * Number(fill.settlement.quoteMicros) / 1e6));
    }
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new Error('Invalid fleet tick interval');
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One deterministic fleet cycle: guard sample, window update, one bounded submission.
   *  Public for tests and manual inspection; start() just calls this on an interval. */
  async tick() {
    if (this.tickBusy) return;
    this.tickBusy = true;
    try {
      const mono = this.nowMono = this.clock.mono(), wall = this.clock.wall();
      const { transition } = this.guard.sample(this.feed.status(), mono, wall);
      if (transition) {
        const detail = `feed ${transition.from} → ${transition.to}${transition.reason ? `: ${transition.reason}` : ''}`;
        this.store.audit(transition.to === 'healthy' ? 'FLEET_FEED_RESUME' : 'FLEET_FEED_PAUSE', detail);
        for (const bot of this.bots.filter(b => b.status === 'running')) {
          this.journal.record({ time: new Date(wall).toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol,
            decision: transition.to === 'healthy' ? 'guard-resume' : 'guard-pause', rationale: detail });
        }
      }
      if (wall - this.lastGuardPersist > 60000) { this.guard.persist(); this.lastGuardPersist = wall; }
      const snapshot = this.paper.status();
      this.updateWindows(snapshot, wall);
      if (!this.store.get('fleetEnabled')) {
        for (const bot of this.bots.filter(b => b.status === 'running')) this.skip(bot, 'Fleet automation is disabled', snapshot, 60000);
        return;
      }
      for (const bot of this.bots.filter(b => b.status === 'running')) {
        await this.step(bot, snapshot);
        if (this.submitBusy) break; // One matcher submission per tick; the executor is single-flight.
      }
    } finally { this.tickBusy = false; }
  }

  private updateWindows(snapshot: PaperStatus, wall: number) {
    const live = new Set<string>();
    for (const bot of this.bots) {
      const market = snapshot.markets.find((m: any) => m.symbol === bot.symbol);
      if (!market) continue;
      live.add(bot.id);
      const quote = this.feed.read(market.market_id, 1);
      if (!quote || !quote.stats) continue;
      const mid = midPrice({ bids: quote.bids, asks: quote.asks, time: quote.receivedAt ?? null });
      if (mid === null) continue;
      const samples = this.windows.get(bot.id) ?? [];
      const last = samples.at(-1);
      if (!last || wall - Date.parse(last.time) >= 1000) {
        samples.push({ time: new Date(wall).toISOString(), mid });
        if (samples.length > 3600) samples.shift();
        this.windows.set(bot.id, samples);
      }
    }
    for (const id of [...this.windows.keys()]) if (!live.has(id)) this.windows.delete(id);
  }

  private skip(bot: FleetBot, reason: string, snapshot: PaperStatus, throttleMs = 30000, checks: { check: string; pass: boolean; detail?: string }[] = []) {
    const key = `${bot.id}:${reason}`, now = this.clock.wall();
    if (now - (this.lastSkipJournal.get(key) ?? 0) < throttleMs) return;
    this.lastSkipJournal.set(key, now);
    this.journal.record({ time: new Date(now).toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol, decision: 'skip', rationale: reason, riskChecks: checks });
    bot.stats.lastDecisionAt = new Date(now).toISOString();
    if (!bot.stats.lastError) bot.stats.lastError = reason;
  }

  private async step(bot: FleetBot, snapshot: PaperStatus) {
    const now = this.clock.wall(), wall = new Date(now).toISOString();
    const market = snapshot.markets.find((m: any) => m.symbol === bot.symbol);
    if (!market) return this.skip(bot, 'Market metadata unavailable', snapshot);
    // Daily bot loss is a safety pause: it runs before any proposal can act.
    const dayRealized = snapshot.analytics.trades.filter((t: any) => t.botId === bot.id && t.time.slice(0, 10) === wall.slice(0, 10)).reduce((s: number, t: any) => s + t.pnl, 0);
    if (dayRealized <= -bot.maxDailyLossUsd) {
      bot.status = 'paused'; bot.stats.lastError = `Daily loss limit: ${dayRealized.toFixed(2)} USD`;
      this.save(); this.store.audit('FLEET_BOT_DAILY_LOSS', `${bot.id}: ${dayRealized.toFixed(2)} USD realized today; bot paused`);
      this.journal.record({ time: wall, botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol, decision: 'bot-pause', rationale: bot.stats.lastError });
      return;
    }
    const strategy = this.registry.get(bot.strategyId);
    if (this.promotion && !this.promotion.allows(strategy, bot.params)) {
      return this.skip(bot, 'Strategy config is not promoted by the research gate', snapshot, 30000,
        [{ check: 'research-promotion', pass: false, detail: this.promotion.describe().mode }]);
    }
    const quote = this.feed.read(market.market_id);
    if (!quote) return this.skip(bot, 'No validated executable book', snapshot);
    const trades = this.feed.evidence ? this.feed.evidence.recentTrades(market.market_id, 100) : [];
    const position = snapshot.analytics.positions.find((p: any) => p.symbol === `${bot.symbol}-USD`) ?? null;
    const ctx: StrategyContext = {
      symbol: bot.symbol,
      book: { bids: quote.bids, asks: quote.asks, time: quote.receivedAt ?? null },
      stats: quote.stats ? { mark: quote.stats.mark, index: quote.stats.index, fundingRate: quote.stats.fundingRate, last: quote.stats.last } : null,
      trades, window: this.windows.get(bot.id) ?? [], params: bot.params,
      position: position ? { quantity: position.quantity, average: position.average, leverage: position.leverage, unrealized: position.unrealized } : null,
      equityUsd: snapshot.analytics.equity, now: wall
    };
    let proposal: StrategyProposal;
    try { proposal = strategy.evaluate(ctx); }
    catch (error) { return this.skip(bot, `Strategy evaluation failed: ${(error as Error).message}`, snapshot); }
    bot.stats.lastDecisionAt = wall;
    const inputs = { mid: midPrice(ctx.book), spread: ctx.book && ctx.book.asks[0] && ctx.book.bids[0] ? ctx.book.asks[0].price - ctx.book.bids[0].price : null,
      fundingRate: ctx.stats?.fundingRate ?? null, positionQuantity: position?.quantity ?? 0, equityUsd: ctx.equityUsd, samples: ctx.window.length };
    if (proposal.action === 'hold') return; // Routine holds are not journaled; the strategy state is visible in the dashboard.
    if (proposal.action === 'open' && !this.guard.verdict(this.nowMono).allowed) {
      return this.skip(bot, `Feed guard: ${this.guard.verdict(this.nowMono).reason}`, snapshot);
    }
    if (proposal.action === 'open' && !this.store.get('fleetEnabled')) {
      return this.skip(bot, 'Fleet automation is disabled', snapshot);
    }
    // One net direction per market: bots and manual orders share the account's single
    // net position, so an opposite open would silently reduce a sibling's exposure.
    if (proposal.action === 'open' && position && ((proposal.side === 'buy') !== (position.quantity > 0))) {
      return this.skip(bot, `One net direction per market: position is ${position.quantity > 0 ? 'long' : 'short'}; close it before opening the opposite side`, snapshot);
    }
    const frequency = this.submitTimes.get(bot.id)?.filter(t => now - t < 3600000).length ?? 0;
    if (proposal.action === 'open' && frequency >= bot.maxOrdersPerHour) {
      return this.skip(bot, `Order frequency cap: ${frequency}/${bot.maxOrdersPerHour} in the last hour`, snapshot);
    }
    if (proposal.action === 'open' && now - (this.lastSubmitAt.get(bot.id) ?? 0) < bot.cooldownMs) {
      return this.skip(bot, `Cooldown ${bot.cooldownMs}ms between submissions`, snapshot);
    }
    const botPnl = snapshot.analytics.bots.find((b: any) => b.botId === bot.id);
    const side = proposal.action === 'open' ? proposal.side : (position!.quantity > 0 ? 'sell' : 'buy');
    const bestPrice = side === 'buy' ? quote.asks[0].price : quote.bids[0].price;
    const sizeDecimals = market.supported_size_decimals as number;
    let quantity: number;
    const riskChecks = [
      { check: 'feed-guard', pass: proposal.action === 'close' || this.guard.verdict(this.nowMono).allowed },
      { check: 'automation-enabled', pass: proposal.action === 'close' || !!this.store.get('fleetEnabled') },
      { check: 'daily-loss', pass: dayRealized > -bot.maxDailyLossUsd, detail: `${dayRealized.toFixed(2)} / -${bot.maxDailyLossUsd} USD` }
    ];
    if (proposal.action === 'open') {
      const budget = Math.min(bot.maxNotionalPerOrder, Math.max(0, bot.maxOpenNotional - (this.openNotional.get(bot.id) ?? 0)));
      if (budget < 10) return this.skip(bot, 'Per-bot notional budget exhausted', snapshot, 30000, riskChecks);
      quantity = floorTo(budget / bestPrice, sizeDecimals);
    } else {
      if (!position) return this.skip(bot, 'Nothing to close', snapshot);
      if (!Number.isFinite(proposal.fraction) || proposal.fraction <= 0 || proposal.fraction > 1) return this.skip(bot, 'Invalid close fraction', snapshot);
      quantity = floorTo(Math.abs(position.quantity) * proposal.fraction, sizeDecimals);
    }
    if (quantity <= 0 || quantity < Number(market.min_base_amount)) {
      return this.skip(bot, `Quantity below venue minimum ${market.min_base_amount} ${bot.symbol}`, snapshot, 30000, riskChecks);
    }
    if (quantity * bestPrice < Number(market.min_quote_amount)) {
      return this.skip(bot, `Order value below venue minimum $${market.min_quote_amount}`, snapshot, 30000, riskChecks);
    }
    const leverage = Math.max(1, Math.min(bot.leverage, leverageLimit(market)));
    const orderId = crypto.randomUUID();
    bot.stats.orders++; this.save();
    this.journal.record({ time: wall, botId: bot.id, strategyId: bot.strategyId, strategyHash: undefined, symbol: bot.symbol,
      decision: 'submit', side, quantity, price: bestPrice, rationale: proposal.rationale, inputs,
      riskChecks: [...riskChecks, { check: 'notional-budget', pass: true, detail: `${(quantity * bestPrice).toFixed(2)} USD` }], orderId });
    const beforeRealized = botPnl?.realized ?? 0;
    this.submitBusy = true;
    try {
      const result = await this.paper.botOrder({ id: orderId, symbol: bot.symbol, side, quantity, leverage, botId: bot.id, reason: proposal.rationale.slice(0, 200) });
      this.submitTimes.set(bot.id, [...(this.submitTimes.get(bot.id) ?? []).slice(-200), now]);
      this.lastSubmitAt.set(bot.id, now);
      const filled = result.status === 'filled' || result.status === 'partial-canceled';
      bot.stats.lastError = result.error ?? null;
      if (filled) {
        bot.stats.fills++;
        this.rebuildOpenNotional();
        const fresh = this.paper.status();
        const after = fresh.analytics.bots.find((b: any) => b.botId === bot.id)?.realized ?? beforeRealized;
        const delta = after - beforeRealized;
        if (delta !== 0) this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol,
          decision: 'fill', side, quantity: result.filled ?? 0, price: result.price ?? null, rationale: `${proposal.rationale} · realized Δ ${delta.toFixed(2)} USD (closing-leg attribution)`, orderId: result.id });
        else this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol,
          decision: result.status === 'partial-canceled' ? 'partial' : 'fill', side, quantity: result.filled ?? 0, price: result.price ?? null, rationale: proposal.rationale, orderId: result.id });
      } else {
        bot.stats.rejected++;
        this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol,
          decision: 'reject', side, quantity, rationale: proposal.rationale, error: result.error ?? result.status, orderId: result.id });
      }
    } catch (error) {
      bot.stats.rejected++; bot.stats.lastError = (error as Error).message;
      this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol,
        decision: 'reject', side, quantity, rationale: proposal.rationale, error: (error as Error).message, orderId });
    } finally {
      this.submitBusy = false;
      this.save();
    }
  }

  // ---- Operator commands -------------------------------------------------------

  private requireIdleSubmit() { if (this.submitBusy) throw new Error('A bot order is in flight; retry in a moment'); }

  create(body: any) {
    this.requireIdleSubmit();
    const slug = typeof body?.slug === 'string' && SLUG.test(body.slug) ? body.slug : null;
    if (!slug) throw new Error('Bot slug required: 2–31 chars, lowercase letters, digits, dashes');
    const id = `fleet-${slug}`;
    if (this.bot(id)) throw new Error(`Bot ${id} already exists`);
    const strategy = this.registry.get(body.strategyId ?? '');
    const params = validateParams(strategy, body.params ?? {});
    if (this.promotion && !this.promotion.allows(strategy, params)) throw new Error(`Strategy config not promoted by the research gate (${this.promotion.mode}); run scripts/research-promote.ts first`);
    const symbol = body.symbol;
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) throw new Error('Invalid market symbol');
    const risk = this.store.get('risk') ?? { maxOrderNotional: 40000 };
    const bot: FleetBot = {
      id, name: typeof body.name === 'string' && body.name.trim() && body.name.length <= 60 ? body.name.trim() : strategy.name,
      strategyId: strategy.id, params, symbol, leverage: money(body.leverage ?? 1, 'leverage', 1, 20),
      maxNotionalPerOrder: money(body.maxNotionalPerOrder ?? 1000, 'maxNotionalPerOrder', 10, risk.maxOrderNotional),
      maxOpenNotional: money(body.maxOpenNotional ?? 2000, 'maxOpenNotional', 10, 1e8),
      maxOrdersPerHour: money(body.maxOrdersPerHour ?? 30, 'maxOrdersPerHour', 1, 120),
      cooldownMs: money(body.cooldownMs ?? 5000, 'cooldownMs', 1000, 3600000),
      maxDailyLossUsd: money(body.maxDailyLossUsd ?? 100, 'maxDailyLossUsd', 1, 1e6),
      status: 'paused', createdAt: new Date().toISOString(),
      stats: { orders: 0, fills: 0, rejected: 0, lastDecisionAt: null, lastError: null }
    };
    this.bots.push(bot); this.save();
    this.store.audit('FLEET_BOT_CREATE', `${id}: ${strategy.id} on ${symbol}; paper-only`);
    this.journal.record({ time: bot.createdAt, botId: id, strategyId: strategy.id, symbol, decision: 'bot-create', rationale: `${bot.name}; caps ${bot.maxNotionalPerOrder}/${bot.maxOpenNotional} USD, ${bot.maxOrdersPerHour}/h, loss stop ${bot.maxDailyLossUsd} USD` });
    this.hooks.onWatchChange?.();
    return this.status();
  }

  update(body: any) {
    this.requireIdleSubmit();
    const bot = this.bot(body?.id);
    if (!bot) throw new Error('Unknown bot');
    if (bot.status === 'running') throw new Error('Pause the bot before editing it');
    if (body.params !== undefined || (body.strategyId !== undefined && body.strategyId !== bot.strategyId)) {
      const strategy = this.registry.get(body.strategyId ?? bot.strategyId);
      const nextParams = validateParams(strategy, body.params ?? bot.params);
      if (this.promotion && !this.promotion.allows(strategy, nextParams)) throw new Error(`Strategy config not promoted by the research gate (${this.promotion.mode}); run scripts/research-promote.ts first`);
      bot.strategyId = strategy.id;
      bot.params = nextParams;
      this.windows.delete(bot.id);
    }
    if (body.symbol !== undefined) {
      if (typeof body.symbol !== 'string' || !SYMBOL.test(body.symbol)) throw new Error('Invalid market symbol');
      if (body.symbol !== bot.symbol) { bot.symbol = body.symbol; this.windows.delete(bot.id); }
    }
    const risk = this.store.get('risk') ?? { maxOrderNotional: 40000 };
    if (body.leverage !== undefined) bot.leverage = money(body.leverage, 'leverage', 1, 20);
    if (body.maxNotionalPerOrder !== undefined) bot.maxNotionalPerOrder = money(body.maxNotionalPerOrder, 'maxNotionalPerOrder', 10, risk.maxOrderNotional);
    if (body.maxOpenNotional !== undefined) bot.maxOpenNotional = money(body.maxOpenNotional, 'maxOpenNotional', 10, 1e8);
    if (body.maxOrdersPerHour !== undefined) bot.maxOrdersPerHour = money(body.maxOrdersPerHour, 'maxOrdersPerHour', 1, 120);
    if (body.cooldownMs !== undefined) bot.cooldownMs = money(body.cooldownMs, 'cooldownMs', 1000, 3600000);
    if (body.maxDailyLossUsd !== undefined) bot.maxDailyLossUsd = money(body.maxDailyLossUsd, 'maxDailyLossUsd', 1, 1e6);
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw new Error('Invalid bot name');
      bot.name = body.name.trim();
    }
    this.save();
    this.store.audit('FLEET_BOT_UPDATE', bot.id);
    this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol, decision: 'bot-update', rationale: 'Bot configuration updated' });
    this.hooks.onWatchChange?.();
    return this.status();
  }

  delete(body: any) {
    this.requireIdleSubmit();
    const bot = this.bot(body?.id);
    if (!bot) throw new Error('Unknown bot');
    if (bot.status === 'running') throw new Error('Pause the bot before deleting it');
    if (this.openNotional.get(bot.id)) throw new Error('Bot still has open notional attributed; close its positions first');
    this.bots = this.bots.filter(b => b.id !== bot.id);
    this.windows.delete(bot.id); this.submitTimes.delete(bot.id); this.lastSubmitAt.delete(bot.id); this.openNotional.delete(bot.id);
    this.save();
    this.store.audit('FLEET_BOT_DELETE', bot.id);
    this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol, decision: 'bot-delete', rationale: 'Bot removed' });
    this.hooks.onWatchChange?.();
    return this.status();
  }

  startBot(body: any) {
    this.requireIdleSubmit();
    const bot = this.bot(body?.id);
    if (!bot) throw new Error('Unknown bot');
    if (bot.status === 'running') return this.status();
    if (this.store.get('halted')) throw new Error('Emergency halt is latched. Reset explicitly before starting.');
    bot.status = 'running'; bot.stats.lastError = null;
    this.save(); this.store.audit('FLEET_BOT_START', bot.id);
    this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol, decision: 'bot-start', rationale: 'Operator started the bot (paper only)' });
    this.hooks.onWatchChange?.();
    return this.status();
  }

  pauseBot(body: any) {
    this.requireIdleSubmit();
    const bot = this.bot(body?.id);
    if (!bot) throw new Error('Unknown bot');
    bot.status = 'paused';
    this.save(); this.store.audit('FLEET_BOT_PAUSE', bot.id);
    this.journal.record({ time: new Date().toISOString(), botId: bot.id, strategyId: bot.strategyId, symbol: bot.symbol, decision: 'bot-pause', rationale: 'Operator paused the bot' });
    return this.status();
  }

  enable(body: any) {
    if (body?.confirm !== 'ENABLE PAPER AUTOMATION') throw new Error('Explicit "ENABLE PAPER AUTOMATION" confirmation required');
    if (this.store.get('halted')) throw new Error('Emergency halt is latched');
    this.store.set('fleetEnabled', true);
    this.store.audit('FLEET_AUTOMATION_ON', 'Bounded paper automation authorized for this session only');
    this.journal.record({ time: new Date().toISOString(), botId: 'fleet-system', strategyId: 'system', symbol: 'all', decision: 'automation-enable', rationale: 'Operator authorized paper automation for this session' });
    return this.status();
  }

  disable() {
    this.store.set('fleetEnabled', false);
    this.store.audit('FLEET_AUTOMATION_OFF', 'Fleet automation authorization withdrawn');
    this.journal.record({ time: new Date().toISOString(), botId: 'fleet-system', strategyId: 'system', symbol: 'all', decision: 'automation-disable', rationale: 'Operator withdrew paper automation' });
    return this.status();
  }

  status() {
    let snapshot: PaperStatus | null = null;
    try { snapshot = this.paper.status(); } catch { snapshot = null; }
    const attribution = new Map<string, any>((snapshot?.analytics.bots ?? []).map((b: any) => [b.botId as string, b]));
    return {
      enabled: !!this.store.get('fleetEnabled'),
      guard: this.guard.status(),
      strategies: this.registry.list(),
      promotion: this.promotion ? this.promotion.describe() : { mode: 'unverified', reasons: ['No research gate installed; strategy configs are not SPA-verified.'] },
      bots: this.bots.map(bot => {
        const a = attribution.get(bot.id);
        const dayKey = new Date().toISOString().slice(0, 10);
        const dayRealized = (snapshot?.analytics.trades ?? []).filter((t: any) => t.botId === bot.id && t.time.slice(0, 10) === dayKey).reduce((s: number, t: any) => s + t.pnl, 0);
        return { ...bot, windowSamples: this.windows.get(bot.id)?.length ?? 0, openNotionalUsd: this.openNotional.get(bot.id) ?? 0,
          attribution: a ? { realized: a.realized, fees: a.fees, trades: a.trades, winRate: a.winRate, fills: a.fills, volume: a.volume } : null,
          dayRealizedUsd: dayRealized };
      }),
      journal: this.journal.list({ limit: 50 }),
      limits: { note: 'Closer-of-closed-leg attribution; funding and open P&L are account-level. Automation authorization does not survive restart.', maxBots: 12 }
    };
  }
}
