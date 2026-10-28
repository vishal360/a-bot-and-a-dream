import type { Fill, Mark, ClosedTrade } from './ledger';
import { units } from './paper-math';

export const ATOMS = 100000000n;
export const HOUR_MS = 3600000;
export const dollars = (micros: bigint) => {
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Ledger reporting overflow');
  return Number(micros) / 1000000;
};
/** History-derived funding under the simulator's timestamp policy. Negative payment is paid. */
export type FundingEvent = {
  version: 1; id: string; symbol: string; marketId: number; timestamp: number; time: string;
  rate: string; direction: 'long' | 'short'; valuePerUnit: string; positionAtoms: string; paymentMicros: string;
  source: string; raw: unknown; recordedAt: string; sha256: string;
};
/** Cash-flow schema for offline replay. Durable transfer admission/chain validation is not enabled. */
export type CashFlow = {
  version: 1; seq: number; id: string; kind: 'deposit' | 'withdrawal'; amountMicros: string; time: string;
  reason: string; previousSha256: string; sha256: string;
};
export type LedgerEvents = { funding?: FundingEvent[]; cashFlows?: CashFlow[] };
const abs = (n: bigint) => n < 0n ? -n : n;
export function floorDiv(a: bigint, b: bigint) {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}
/**
 * Venue rule: funding = -position * index * rate. Hourly history reports the per-unit
 * amount (`value`, USDC per base unit) and the paying side (`direction`). Atoms (1e-8 base)
 * times value (1e-8 USDC) is 1e-10 micro-USDC; flooring charges debits up and credits down.
 */
export function fundingPayment(positionAtoms: bigint, valuePerUnit: string, direction: 'long' | 'short') {
  if (direction !== 'long' && direction !== 'short') throw new Error('Invalid funding direction');
  return floorDiv((direction === 'long' ? -1n : 1n) * positionAtoms * units(valuePerUnit, 8), 10000000000n);
}
/** One order may open/increase or reduce, never flip through zero. */
export function positionEffect(side: 'buy' | 'sell', quantity: bigint, held: bigint): 'open' | 'reduce' {
  if (!['buy', 'sell'].includes(side) || quantity <= 0n) throw new Error('Invalid position effect');
  if (held === 0n || (side === 'buy') === (held > 0n)) return 'open';
  if (quantity > abs(held)) throw new Error('One order cannot flip a position: close it first, then open the opposite side');
  return 'reduce';
}
export function cashFlowDelta(flow: CashFlow) {
  if (!/^[1-9]\d{0,15}$/.test(flow.amountMicros) || !['deposit', 'withdrawal'].includes(flow.kind)) throw new Error('Invalid paper cash flow');
  return (flow.kind === 'deposit' ? 1n : -1n) * BigInt(flow.amountMicros);
}
/** Legacy fills are replayed, never rewritten. Only their quote/fee are rounded to micro-dollars. */
export function paperBalance(fills: Fill[], capital: number, events: LedgerEvents = {}) {
  let cash = units(capital, 6), quantity = 0n, basis = 0n, gross = 0n, fees = 0n, legacyFills = 0;
  let funding = 0n, transfers = 0n, liquidationFees = 0n;
  const inventory = new Map<string, { quantity: bigint; basis: bigint; entryFees: bigint; margin: bigint; leverage: number; funding: bigint }>();
  const daily = new Map<string, bigint>();
  const trades: ClosedTrade[] = [], tradeMicros: bigint[] = [], curve: { time: string; value: number; drawdown: number }[] = [];
  let peak = cash, maxDrawdown = 0;
  const ids = new Set<string>();
  const timeline = [
    ...fills.map(f => ({ time: f.time, priority: 1, fill: f, funding: undefined as FundingEvent | undefined, flow: undefined as CashFlow | undefined })),
    ...(events.funding ?? []).map(f => ({ time: f.time, priority: 0, fill: undefined, funding: f, flow: undefined })),
    ...(events.cashFlows ?? []).map(f => ({ time: f.time, priority: 2, fill: undefined, funding: undefined, flow: f })),
  ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.priority - b.priority);
  const record = (time: string, before: bigint) => {
    const net = gross - fees + funding, day = new Date(time).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0n) + net - before);
    // Cash flows are not trading profits or drawdown. Curve is transfer-adjusted.
    const value = units(capital, 6) + net;
    if (value > peak) peak = value;
    const drawdown = peak > 0n ? Number(peak - value) / Number(peak) : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    curve.push({ time, value: dollars(value), drawdown });
  };
  for (const event of timeline) {
    if (!Number.isFinite(Date.parse(event.time))) throw new Error('Invalid paper timestamp');
    const before = gross - fees + funding;
    if (event.flow) {
      const flow = event.flow;
      if (ids.has(`cash:${flow.id}`)) throw new Error('Duplicate paper cash flow');
      ids.add(`cash:${flow.id}`);
      const delta = cashFlowDelta(flow); cash += delta; transfers += delta;
      if (delta < 0n && cash < 0n) throw new Error('Withdrawal exceeds free cash');
      dollars(cash); continue;
    }
    if (event.funding) {
      const f = event.funding, p = inventory.get(f.symbol), held = p?.quantity ?? 0n;
      if (f.version !== 1 || !Number.isSafeInteger(f.timestamp) || f.timestamp * 1000 !== Date.parse(f.time) || f.timestamp % 3600 !== 0 ||
          ids.has(`funding:${f.id}`) || f.positionAtoms !== held.toString() ||
          f.paymentMicros !== fundingPayment(held, f.valuePerUnit, f.direction).toString()) throw new Error('Invalid funding settlement or position snapshot');
      ids.add(`funding:${f.id}`);
      const payment = BigInt(f.paymentMicros); cash += payment; funding += payment;
      if (p) p.funding += payment;
      dollars(cash); dollars(funding); record(f.time, before); continue;
    }
    const f = event.fill!;
    if (typeof f.id !== 'string' || !f.id || ids.has(f.id)) throw new Error('Invalid or duplicate paper fill ID');
    ids.add(f.id);
    if (!Number.isFinite(Date.parse(f.time))) throw new Error('Invalid paper timestamp');
    if (f.account !== 'paper-mainnet' || !/^[A-Za-z0-9._/-]{1,80}-USD$/.test(f.symbol) ||
        (f.botId !== 'orion' && !/^fleet-[a-z0-9-]{3,40}$/.test(f.botId) && !/^agent-[a-z0-9-]{3,40}$/.test(f.botId)) || f.multiplier !== 1 || !['buy', 'sell'].includes(f.side)) throw new Error('Unsupported paper inventory');
    const p = inventory.get(f.symbol) ?? { quantity: 0n, basis: 0n, entryFees: 0n, margin: 0n, leverage: 1, funding: 0n };
    inventory.set(f.symbol, p);
    const q = units(f.quantity, 8);
    let quote: bigint, fee: bigint;
    if (f.settlement) {
      const s = f.settlement;
      if (![1, 2].includes(s.version) || ![s.quantityAtoms, s.quoteMicros, s.feeMicros].every(v => typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)) || BigInt(s.quantityAtoms) !== q) throw new Error('Invalid paper settlement');
      quote = BigInt(s.quoteMicros); fee = BigInt(s.feeMicros);
      if (s.liquidationFeeMicros !== undefined) {
        if (s.version !== 2 || s.effect !== 'reduce' || !/^\d+$/.test(s.liquidationFeeMicros)) throw new Error('Invalid liquidation fee');
        const extra = BigInt(s.liquidationFeeMicros); liquidationFees += extra; fee += extra;
      }
    } else {
      if (!Number.isFinite(f.price) || f.price <= 0 || !Number.isFinite(f.fee) || f.fee < 0) throw new Error('Invalid legacy economics');
      quote = units((f.quantity * f.price).toFixed(6), 6); fee = units(f.fee.toFixed(6), 6); legacyFills++;
    }
    if (q <= 0n || quote <= 0n) throw new Error('Invalid paper economics');
    fees += fee;
    const leverage = f.settlement?.leverage ?? 1;
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 20) throw new Error('Invalid paper leverage');
    const effect = f.settlement?.version === 2 ? positionEffect(f.side, q, p.quantity) : f.side === 'buy' ? 'open' : 'reduce';
    if (f.settlement?.version === 2 && f.settlement.effect !== effect) throw new Error('Settlement position effect mismatch');
    if (f.settlement?.version !== 2 && (p.quantity < 0n || (f.side === 'sell' && q > p.quantity))) throw new Error('Paper ledger oversell');
    if (effect === 'open') {
      if (p.quantity && p.leverage !== leverage) throw new Error('Cannot change leverage on an open position');
      const margin = (quote + BigInt(leverage) - 1n) / BigInt(leverage);
      cash -= margin + fee; p.margin += margin; p.leverage = leverage; p.quantity += f.side === 'buy' ? q : -q; p.basis += quote; p.entryFees += fee;
    }
    else {
      if (q > abs(p.quantity)) throw new Error('Paper ledger oversell');
      const held = abs(p.quantity), sign = p.quantity > 0n ? 1n : -1n;
      // Allocate whole micro-dollars; the final close consumes every remaining unit.
      const closingBasis = q === held ? p.basis : p.basis * q / held;
      const closingFees = q === held ? p.entryFees : p.entryFees * q / held;
      const closingMargin = q === held ? p.margin : p.margin * q / held;
      const closingFunding = q === held ? p.funding : floorDiv(p.funding * q, held);
      const pnl = sign * (quote - closingBasis), net = pnl - closingFees - fee + closingFunding;
      tradeMicros.push(net);
      trades.push({ id: f.id, account: f.account, botId: f.botId, symbol: f.symbol, time: f.time,
        pnl: dollars(net), quantity: Number(q) / 1e8, side: sign > 0n ? 'long' : 'short',
        entry: dollars(closingBasis) / (Number(q) / 1e8), exit: dollars(quote) / (Number(q) / 1e8) });
      p.entryFees -= closingFees;
      p.funding -= closingFunding;
      p.basis -= closingBasis; p.margin -= closingMargin; p.quantity -= sign * q; cash += closingMargin + pnl - fee; gross += pnl;
    }
    // A gap can lose more than collateral. Never hide insolvency or reject a loss-reducing exit.
    // Reconciliation must not invalidate already-committed fills when a delayed debit
    // is inserted at its economic hour. New orders still check actual free cash.
    const lateDebits = (events.funding ?? []).filter(e => Date.parse(e.time) <= Date.parse(f.time) && Date.parse(e.recordedAt) > Date.parse(f.time) && BigInt(e.paymentMicros) < 0n)
      .reduce((sum, e) => sum + BigInt(e.paymentMicros), 0n);
    if (cash - lateDebits < 0n && effect === 'open') throw new Error('Paper ledger negative cash');
    if (abs(p.quantity) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Inventory overflow');
    dollars(cash); dollars(p.basis); dollars(fees); dollars(gross);
    record(f.time, before);
  }
  // Legacy scalar quantity is BTC only; never add quantities of different assets.
  quantity = inventory.get('BTC-USD')?.quantity ?? 0n;
  basis = [...inventory.values()].reduce((sum, p) => sum + p.basis, 0n);
  return { cash, quantity, basis, inventory, gross, fees, funding, transfers, liquidationFees, realized: gross - fees + funding, legacyFills, daily, trades, tradeMicros, curve, maxDrawdown };
}

export function markedMicros(quantity: bigint, price: number) {
  return floorDiv(quantity * units(price, 8), ATOMS * 100n);
}

/** One authoritative report for the manual account, including the Operations view. */
export function paperAnalytics(fills: Fill[], marks: Mark[], capital: number, now = new Date(), events: LedgerEvents = {}) {
  const b = paperBalance(fills, capital, events);
  let value = 0n, missingMarks = 0, staleMarks = 0;
  const positions = [...b.inventory].filter(([, p]) => p.quantity !== 0n).map(([symbol, p]) => {
    const mark = marks.filter(m => m.account === 'paper-mainnet' && m.symbol === symbol)
      .sort((a, z) => Date.parse(z.time) - Date.parse(a.time))[0];
    const valid = !!mark && Number.isFinite(mark.price) && mark.price > 0 && Number.isFinite(Date.parse(mark.time)) && Date.parse(mark.time) <= now.getTime();
    const signedBasis = p.quantity > 0n ? p.basis : -p.basis;
    const marked = valid ? markedMicros(p.quantity, mark.price) - signedBasis : null;
    if (marked === null) missingMarks++; else value += marked;
    const stale = valid && now.getTime() - Date.parse(mark.time) > 15000;
    if (stale) staleMarks++;
    return { account: 'paper-mainnet', botId: 'orion', symbol, quantity: Number(p.quantity) / 1e8, leverage: p.leverage, margin: dollars(p.margin),
      average: dollars(p.basis) / (Number(abs(p.quantity)) / 1e8), multiplier: 1, side: p.quantity > 0n ? 'long' as const : 'short' as const,
      unrealized: marked === null ? null : dollars(marked), entryFees: dollars(p.entryFees), funding: dollars(p.funding),
      openNetPnl: marked === null ? null : dollars(marked - p.entryFees + p.funding), stale,
      mark: valid ? mark.price : null, markTime: valid ? mark.time : null };
  });
  const unrealized = missingMarks ? null : dollars(value);
  const wins = b.trades.filter(t => t.pnl > 0);
  // Trade money is summed in integer units; ratios are display-only numbers.
  const winSum = b.tradeMicros.filter(n => n > 0n).reduce((s, n) => s + n, 0n);
  const lossSum = -b.tradeMicros.filter(n => n < 0n).reduce((s, n) => s + n, 0n);
  const net = b.tradeMicros.reduce((s, n) => s + n, 0n);
  const sorted = [...b.trades].sort((a, z) => z.pnl - a.pnl), winRate = b.trades.length ? wins.length / b.trades.length : 0;
  const executionAverage = (side: 'buy' | 'sell') => {
    let quantity = 0n, quote = 0n;
    for (const f of fills.filter(f => f.side === side)) {
      quantity += units(f.quantity, 8);
      quote += f.settlement ? BigInt(f.settlement.quoteMicros) : units((f.quantity * f.price).toFixed(6), 6);
    }
    return quantity ? dollars(quote) / (Number(quantity) / 1e8) : null;
  };
  const margin = [...b.inventory.values()].reduce((sum, p) => sum + p.margin, 0n);
  // Per-actor attribution: closed legs belong to the actor that closed them; fees to the fill's actor.
  // Mixed manual/bot/agent positions share one average position, so open P&L is not attributable.
  const actorIds = [...new Set(fills.map(f => f.botId))].sort();
  const actorFees = new Map<string, bigint>();
  for (const f of fills) {
    const fee = f.settlement ? BigInt(f.settlement.feeMicros) : units(f.fee.toFixed(6), 6);
    actorFees.set(f.botId, (actorFees.get(f.botId) ?? 0n) + fee);
  }
  const actors = actorIds.map(actorId => {
    const closed = b.trades.filter(t => t.botId === actorId), micros = b.tradeMicros.filter((_, i) => b.trades[i].botId === actorId);
    const wins = micros.filter(n => n > 0n).length;
    const actorFills = fills.filter(f => f.botId === actorId);
    return { botId: actorId, realized: dollars(micros.reduce((s, n) => s + n, 0n)), fees: dollars(actorFees.get(actorId) ?? 0n),
      trades: closed.length, winRate: closed.length ? wins / closed.length : 0, unrealized: null as number | null, fills: actorFills.length,
      volume: actorFills.reduce((s, f) => s + (f.settlement ? Number(f.settlement.quoteMicros) : Number(units((f.quantity * f.price).toFixed(6), 6))) / 1e6, 0) };
  });
  const bots = actors.filter(row => !row.botId.startsWith('agent-'));
  const agents = actors.filter(row => row.botId.startsWith('agent-'));
  return { capital, cash: dollars(b.cash), marginUsed: dollars(margin), gross: dollars(b.gross), fees: dollars(b.fees), funding: dollars(b.funding), transfers: dollars(b.transfers), liquidationFees: dollars(b.liquidationFees), realized: dollars(b.realized), unrealized,
    averageBuy: b.inventory.size > 1 ? null : executionAverage('buy'), averageSell: b.inventory.size > 1 ? null : executionAverage('sell'),
    equity: missingMarks ? null : dollars(b.cash + margin + value), positions, trades: b.trades, fillCount: fills.length,
    today: dollars(b.daily.get(now.toISOString().slice(0, 10)) ?? 0n), daily: [...b.daily].map(([day, pnl]) => ({ day, pnl: dollars(pnl) })),
    winRate, profitFactor: lossSum ? Number(winSum) / Number(lossSum) : null, expectancy: b.trades.length ? dollars(net) / b.trades.length : 0,
    maxDrawdown: b.maxDrawdown, curve: [{ time: fills[0]?.time ?? now.toISOString(), value: capital, drawdown: 0 }, ...b.curve],
    bots: fills.length ? bots : [],
    agents,
    best: sorted[0] ?? null, worst: sorted.at(-1) ?? null, missingMarks, staleMarks,
    accounting: { version: 3, cashMicros: b.cash.toString(), quantityAtoms: b.quantity.toString(), basisMicros: b.basis.toString(), realizedMicros: b.realized.toString(), fundingMicros: b.funding.toString(), transferMicros: b.transfers.toString(), legacyFills: b.legacyFills,
      inventory: [...b.inventory].map(([symbol, p]) => ({ symbol, quantityAtoms: p.quantity.toString(), basisMicros: p.basis.toString(), entryFeeMicros: p.entryFees.toString() })) } };
}