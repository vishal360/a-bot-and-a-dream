export type Bar = { time: string; open: number; high: number; low: number; close: number };
export type Bot = { id: string; name: string; asset: 'futures' | 'crypto'; symbol: string; status: 'running' | 'paused' | 'halted'; strategy: string; createdAt: string; description: string };
export type Config = { lookback: number; stopPct: number; riskPct: number; feeBps: number; slippageBps: number; capital: number; asset: 'futures' | 'crypto' };
export type Trade = { entryTime: string; exitTime: string; side: 'long'; entry: number; exit: number; quantity: number; pnl: number; reason: string };
export type Result = { config: Config; trades: Trade[]; equity: number[]; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null; source: string; warnings: string[] };
export const defaultConfig: Config = { lookback: 20, stopPct: 0.01, riskPct: 0.005, feeBps: 2, slippageBps: 2, capital: 10000, asset: 'futures' };

export function validateConfig(c: Config) {
  const ranges: [keyof Config, number, number][] = [['lookback', 2, 200], ['stopPct', 0.001, 0.2], ['riskPct', 0.0001, 0.01], ['feeBps', 0, 100], ['slippageBps', 0, 100], ['capital', 100, 100000000]];
  for (const [key, min, max] of ranges) if (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || Number(c[key]) < min || Number(c[key]) > max) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
  if (!Number.isInteger(c.lookback) || !['futures', 'crypto'].includes(c.asset)) throw new Error('Invalid lookback or asset');
}

export function validateBars(bars: Bar[]) {
  if (!Array.isArray(bars) || bars.length < 30 || bars.length > 100000) throw new Error('Dataset must contain 30–100,000 bars');
  let prior = -Infinity;
  for (const b of bars) {
    const time = Date.parse(b.time);
    if (!Number.isFinite(time) || time <= prior) throw new Error('Timestamps must be valid and strictly increasing');
    if (![b.open, b.high, b.low, b.close].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) || b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close)) throw new Error('Invalid OHLC bar');
    prior = time;
  }
}

/** Seeded illustrative prices. Never broker or historical market data. */
export function syntheticBars(asset: 'futures' | 'crypto', count = 720): Bar[] {
  let seed = 42, price = asset === 'futures' ? 5200 : 65000;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: count }, (_, i) => {
    const open = price;
    price *= 1 + (random() - 0.48) * 0.009;
    return { time: new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(), open, high: Math.max(open, price) * (1 + random() * 0.003), low: Math.min(open, price) * (1 - random() * 0.003), close: price };
  });
}

/** Long-only research baseline: completed-bar breakout, next-open fill, conservative stop gaps. */
export function backtest(bars: Bar[], c: Config, source: string): Result {
  validateConfig(c); validateBars(bars);
  const slip = c.slippageBps / 10000, fee = c.feeBps / 10000, multiplier = c.asset === 'futures' ? 5 : 1;
  let cash = c.capital, peak = cash, maxDrawdown = 0;
  let position: { entry: number; quantity: number; stop: number; time: string; entryFee: number } | null = null;
  const trades: Trade[] = [], equity: number[] = [];
  const close = (bar: Bar, raw: number, reason: string) => {
    if (!position) return;
    const exit = raw * (1 - slip), exitFee = exit * position.quantity * multiplier * fee;
    const gross = (exit - position.entry) * position.quantity * multiplier;
    cash += gross - exitFee;
    trades.push({ entryTime: position.time, exitTime: bar.time, side: 'long', entry: position.entry, exit, quantity: position.quantity, pnl: gross - exitFee - position.entryFee, reason });
    position = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!position && i > c.lookback && cash > 0) {
      const signal = bars[i - 1].close > Math.max(...bars.slice(i - c.lookback - 1, i - 1).map(x => x.high));
      if (signal) {
        const entry = b.open * (1 + slip), stop = entry * (1 - c.stopPct);
        const unitRisk = (entry - stop + entry * (slip + 2 * fee)) * multiplier;
        let quantity = Math.min(cash * c.riskPct / unitRisk, cash / (entry * multiplier * (1 + fee)));
        quantity = c.asset === 'futures' ? Math.floor(quantity) : Math.floor(quantity * 1000000) / 1000000;
        if (quantity > 0) {
          const entryFee = entry * quantity * multiplier * fee;
          cash -= entryFee; position = { entry, quantity, stop, time: b.time, entryFee };
        }
      }
    }
    if (position) {
      // A completed-bar channel exit executes at the open, before this bar's low.
      if (position.time !== b.time && i > c.lookback && bars[i - 1].close < Math.min(...bars.slice(i - c.lookback - 1, i - 1).map(x => x.low))) close(b, b.open, 'channel exit');
      else if (b.low <= position.stop) close(b, Math.min(b.open, position.stop), 'protective stop');
      else if (i === bars.length - 1) close(b, b.close, 'end of dataset');
    }
    const value = cash + (position ? (b.close - position.entry) * position.quantity * multiplier : 0);
    equity.push(value); peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  const profits = trades.reduce((s, t) => s + Math.max(t.pnl, 0), 0), losses = -trades.reduce((s, t) => s + Math.min(t.pnl, 0), 0);
  return { config: c, trades, equity, netPnl: cash - c.capital, maxDrawdown, winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length : 0, profitFactor: losses ? profits / losses : null, source,
    warnings: ['Research baseline, not a validated trading edge.', 'No exchange margin, contract rolls, funding, liquidity or session model. Conservative unlevered notional cap.', 'OHLC fills cannot establish intrabar sequencing or live execution quality.', ...(source === 'synthetic' ? ['SYNTHETIC DATA — results are illustrative only.'] : [])] };
}