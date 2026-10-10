export type Fill = { id: string; account: string; botId: string; symbol: string; side: 'buy' | 'sell'; quantity: number; price: number; fee: number; multiplier: number; time: string; source: 'paper' | 'imported'; reason: string; settlement?: { version: 1; quantityAtoms: string; quoteMicros: string; feeMicros: string } };
export type Mark = { account: string; symbol: string; price: number; time: string; source: string };
export type Position = { account: string; botId: string; symbol: string; quantity: number; average: number; multiplier: number; unrealized: number | null; mark: number | null; markTime: string | null };
export type ClosedTrade = { id: string; account: string; botId: string; symbol: string; time: string; pnl: number; quantity: number; entry: number; exit: number };
export function validateFill(f: Fill) {
  for (const k of ['id', 'account', 'botId', 'symbol', 'reason'] as const) if (typeof f[k] !== 'string' || !f[k].trim() || f[k].length > 180) throw new Error(`Invalid ${k}`);
  if (!['buy', 'sell'].includes(f.side) || !['paper', 'imported'].includes(f.source)) throw new Error('Invalid fill side or source');
  if (![f.quantity, f.price, f.multiplier].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(f.fee) || f.fee < 0) throw new Error('Invalid fill economics');
  if (f.quantity > 1e9 || f.price > 1e9 || f.multiplier > 1e6 || f.fee > 1e9) throw new Error('Fill exceeds supported numerical bounds');
  if (!Number.isFinite(Date.parse(f.time)) || Date.parse(f.time) > Date.now() + 60000) throw new Error('Invalid or future fill timestamp');
}
/** Average-cost net inventory by account/bot/symbol. Fees allocated to closing legs. */
export function analytics(fills: Fill[], marks: Mark[], capital: number, now = new Date()) {
  const positions = new Map<string, Position & { entryFees: number }>();
  const trades: ClosedTrade[] = [], daily = new Map<string, number>(), curve: { time: string; value: number; drawdown: number }[] = [];
  let realized = 0, gross = 0, fees = 0, peak = capital, maxDrawdown = 0;
  for (const f of [...fills].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    const key = `${f.account}\0${f.botId}\0${f.symbol}`;
    let p = positions.get(key);
    if (!p) { p = { account: f.account, botId: f.botId, symbol: f.symbol, quantity: 0, average: 0, multiplier: f.multiplier, unrealized: null, mark: null, markTime: null, entryFees: 0 }; positions.set(key, p); }
    if (p.multiplier !== f.multiplier) throw new Error('Inconsistent contract multiplier');
    const signed = f.side === 'buy' ? f.quantity : -f.quantity;
    let pnl = 0;
    if (p.quantity && Math.sign(p.quantity) !== Math.sign(signed)) {
      const closing = Math.min(Math.abs(p.quantity), f.quantity);
      pnl = (f.price - p.average) * Math.sign(p.quantity) * closing * p.multiplier;
      const entryFee = p.entryFees * closing / Math.abs(p.quantity), exitFee = f.fee * closing / f.quantity;
      trades.push({ id: f.id, account: f.account, botId: f.botId, symbol: f.symbol, time: f.time, pnl: pnl - entryFee - exitFee, quantity: closing, entry: p.average, exit: f.price });
      p.entryFees -= entryFee;
      if (f.quantity > Math.abs(p.quantity)) { p.average = f.price; p.entryFees = f.fee * (f.quantity - Math.abs(p.quantity)) / f.quantity; }
      p.quantity += signed;
      if (Math.abs(p.quantity) < 1e-10) { p.quantity = 0; p.average = 0; p.entryFees = 0; }
    } else {
      p.average = (p.average * Math.abs(p.quantity) + f.price * f.quantity) / (Math.abs(p.quantity) + f.quantity);
      p.quantity += signed; p.entryFees += f.fee;
    }
    gross += pnl; fees += f.fee; realized += pnl - f.fee;
    const day = f.time.slice(0, 10); daily.set(day, (daily.get(day) || 0) + pnl - f.fee);
    const value = capital + realized; peak = Math.max(peak, value);
    const dd = peak > 0 ? (peak - value) / peak : 0; maxDrawdown = Math.max(maxDrawdown, dd);
    curve.push({ time: f.time, value, drawdown: dd });
  }
  let unrealized = 0, missingMarks = 0, staleMarks = 0;
  const open = [...positions.values()].filter(p => p.quantity !== 0).map(({ entryFees, ...p }) => {
    const m = marks.filter(m => m.account === p.account && m.symbol === p.symbol).sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
    if (!m) missingMarks++;
    else { p.mark = m.price; p.markTime = m.time; p.unrealized = (m.price - p.average) * p.quantity * p.multiplier; unrealized += p.unrealized; if (now.getTime() - Date.parse(m.time) > 60000) staleMarks++; }
    return p;
  });
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const winSum = wins.reduce((n, t) => n + t.pnl, 0), lossSum = -losses.reduce((n, t) => n + t.pnl, 0);
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const bots = [...new Set(fills.map(f => f.botId))].map(botId => {
    const b = analyticsBot(fills.filter(f => f.botId === botId), trades.filter(t => t.botId === botId), open.filter(p => p.botId === botId)); return { botId, ...b };
  }).sort((a, b) => b.realized - a.realized);
  return { capital, realized, gross, fees, unrealized: missingMarks ? null : unrealized, equity: missingMarks ? null : capital + realized + unrealized, today: daily.get(now.toISOString().slice(0, 10)) || 0, trades, fillCount: fills.length, winRate: trades.length ? wins.length / trades.length : 0, profitFactor: lossSum ? winSum / lossSum : null, expectancy: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0, maxDrawdown, curve: [{ time: fills[0]?.time || now.toISOString(), value: capital, drawdown: 0 }, ...curve], daily: [...daily].map(([day, pnl]) => ({ day, pnl })), positions: open, bots, best: sorted[0] || null, worst: sorted.at(-1) || null, missingMarks, staleMarks };
}
function analyticsBot(fills: Fill[], trades: ClosedTrade[], positions: Position[]) {
  // Per-bot net cash contribution is reconciled from the same inventory algorithm,
  // using closed net P&L less entry fees still attached to open inventory.
  const totalFees = fills.reduce((s, f) => s + f.fee, 0);
  let inventory = new Map<string, { q: number; avg: number }>(), cashPnl = -totalFees;
  for (const f of [...fills].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    const key = `${f.account}/${f.symbol}`, p = inventory.get(key) || { q: 0, avg: 0 }, s = f.side === 'buy' ? f.quantity : -f.quantity;
    if (p.q && Math.sign(p.q) !== Math.sign(s)) { cashPnl += (f.price - p.avg) * Math.sign(p.q) * Math.min(Math.abs(p.q), f.quantity) * f.multiplier; if (f.quantity > Math.abs(p.q)) p.avg = f.price; }
    else p.avg = (Math.abs(p.q) * p.avg + f.quantity * f.price) / (Math.abs(p.q) + f.quantity);
    p.q += s; inventory.set(key, p);
  }
  return { realized: cashPnl, fees: totalFees, trades: trades.length, winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length : 0, unrealized: positions.some(p => p.unrealized === null) ? null : positions.reduce((s, p) => s + (p.unrealized || 0), 0), fills: fills.length };
}