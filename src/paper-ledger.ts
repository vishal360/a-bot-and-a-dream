import type { Fill, Mark, ClosedTrade } from './ledger';
import { units } from './paper-math';

export const ATOMS = 100000000n;
export const dollars = (micros: bigint) => {
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Ledger reporting overflow');
  return Number(micros) / 1000000;
};
/** Legacy fills are replayed, never rewritten. Only their quote/fee are rounded to micro-dollars. */
export function paperBalance(fills: Fill[], capital: number) {
  let cash = units(capital, 6), quantity = 0n, basis = 0n, gross = 0n, fees = 0n, legacyFills = 0;
  const daily = new Map<string, bigint>();
  const trades: ClosedTrade[] = [], tradeMicros: bigint[] = [], curve: { time: string; value: number; drawdown: number }[] = [];
  let entryFees = 0n, peak = cash, maxDrawdown = 0;
  const ids = new Set<string>();
  for (const f of [...fills].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    if (typeof f.id !== 'string' || !f.id || ids.has(f.id)) throw new Error('Invalid or duplicate paper fill ID');
    ids.add(f.id);
    if (!Number.isFinite(Date.parse(f.time))) throw new Error('Invalid paper timestamp');
    const before = gross - fees;
    if (f.account !== 'paper-mainnet' || f.symbol !== 'BTC-USD' || f.botId !== 'orion' || f.multiplier !== 1 || !['buy', 'sell'].includes(f.side)) throw new Error('Unsupported paper inventory');
    const q = units(f.quantity, 8);
    let quote: bigint, fee: bigint;
    if (f.settlement) {
      const s = f.settlement;
      if (s.version !== 1 || ![s.quantityAtoms, s.quoteMicros, s.feeMicros].every(v => typeof v === 'string' && /^\d+$/.test(v)) || BigInt(s.quantityAtoms) !== q) throw new Error('Invalid paper settlement');
      quote = BigInt(s.quoteMicros); fee = BigInt(s.feeMicros);
    } else {
      if (!Number.isFinite(f.price) || f.price <= 0 || !Number.isFinite(f.fee) || f.fee < 0) throw new Error('Invalid legacy economics');
      quote = units((f.quantity * f.price).toFixed(6), 6); fee = units(f.fee.toFixed(6), 6); legacyFills++;
    }
    if (q <= 0n || quote <= 0n) throw new Error('Invalid paper economics');
    fees += fee;
    if (f.side === 'buy') { cash -= quote + fee; quantity += q; basis += quote; entryFees += fee; }
    else {
      if (q > quantity) throw new Error('Paper ledger oversell');
      // Allocate whole micro-dollars; the final close consumes every remaining unit.
      const closingBasis = q === quantity ? basis : basis * q / quantity;
      const closingFees = q === quantity ? entryFees : entryFees * q / quantity;
      tradeMicros.push(quote - closingBasis - closingFees - fee);
      trades.push({ id: f.id, account: f.account, botId: f.botId, symbol: f.symbol, time: f.time,
        pnl: dollars(quote - closingBasis - closingFees - fee), quantity: Number(q) / 1e8,
        entry: dollars(closingBasis) / (Number(q) / 1e8), exit: dollars(quote) / (Number(q) / 1e8) });
      entryFees -= closingFees;
      basis -= closingBasis; quantity -= q; cash += quote - fee; gross += quote - closingBasis;
    }
    if (cash < 0n) throw new Error('Paper ledger negative cash');
    if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Inventory overflow');
    dollars(cash); dollars(basis); dollars(fees); dollars(gross);
    const day = new Date(f.time).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0n) + gross - fees - before);
    const value = units(capital, 6) + gross - fees;
    if (value > peak) peak = value;
    const drawdown = peak > 0n ? Number(peak - value) / Number(peak) : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    curve.push({ time: f.time, value: dollars(value), drawdown });
  }
  return { cash, quantity, basis, gross, fees, realized: gross - fees, legacyFills, daily, trades, tradeMicros, curve, maxDrawdown };
}

export function markedMicros(quantity: bigint, price: number) {
  return quantity * units(price, 8) / (ATOMS * 100n);
}

/** One authoritative report for the manual account, including the Operations view. */
export function paperAnalytics(fills: Fill[], marks: Mark[], capital: number, now = new Date()) {
  const b = paperBalance(fills, capital);
  const mark = marks.filter(m => m.account === 'paper-mainnet' && m.symbol === 'BTC-USD')
    .sort((a, z) => Date.parse(z.time) - Date.parse(a.time))[0];
  const valid = mark && Number.isFinite(mark.price) && mark.price > 0 && Number.isFinite(Date.parse(mark.time)) && Date.parse(mark.time) <= now.getTime();
  const value = b.quantity === 0n ? 0n : !valid ? null : markedMicros(b.quantity, mark.price);
  const unrealized = value === null ? null : dollars(value - b.basis);
  const positions = b.quantity === 0n ? [] : [{ account: 'paper-mainnet', botId: 'orion', symbol: 'BTC-USD', quantity: Number(b.quantity) / 1e8,
    average: dollars(b.basis) / (Number(b.quantity) / 1e8), multiplier: 1, unrealized,
    mark: valid ? mark.price : null, markTime: valid ? mark.time : null }];
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
  return { capital, cash: dollars(b.cash), gross: dollars(b.gross), fees: dollars(b.fees), realized: dollars(b.realized), unrealized,
    averageBuy: executionAverage('buy'), averageSell: executionAverage('sell'),
    equity: value === null ? null : dollars(b.cash + value), positions, trades: b.trades, fillCount: fills.length,
    today: dollars(b.daily.get(now.toISOString().slice(0, 10)) ?? 0n), daily: [...b.daily].map(([day, pnl]) => ({ day, pnl: dollars(pnl) })),
    winRate, profitFactor: lossSum ? Number(winSum) / Number(lossSum) : null, expectancy: b.trades.length ? dollars(net) / b.trades.length : 0,
    maxDrawdown: b.maxDrawdown, curve: [{ time: fills[0]?.time ?? now.toISOString(), value: capital, drawdown: 0 }, ...b.curve],
    bots: fills.length ? [{ botId: 'orion', realized: dollars(b.realized), fees: dollars(b.fees), trades: b.trades.length, winRate, unrealized, fills: fills.length }] : [],
    best: sorted[0] ?? null, worst: sorted.at(-1) ?? null, missingMarks: b.quantity !== 0n && !valid ? 1 : 0,
    staleMarks: b.quantity !== 0n && valid && now.getTime() - Date.parse(mark.time) > 60000 ? 1 : 0,
    accounting: { version: 1, cashMicros: b.cash.toString(), quantityAtoms: b.quantity.toString(), basisMicros: b.basis.toString(), realizedMicros: b.realized.toString(), legacyFills: b.legacyFills } };
}