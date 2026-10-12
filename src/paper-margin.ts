import type { Mark } from './ledger';
import { markedMicros, dollars, type paperBalance } from './paper-ledger';
import { units } from './paper-math';

export function paperMargin(balance: ReturnType<typeof paperBalance>, marks: Mark[], markets: any[], now = Date.now()) {
  let equity = balance.cash, initial = 0n, maintenance = 0n, closeout = 0n, exposure = 0n;
  let approximate = false;
  for (const [symbol, p] of balance.inventory) {
    equity += p.margin;
    if (!p.quantity) continue;
    const mark = marks.filter(m => m.account === 'paper-mainnet' && m.symbol === symbol).sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
    if (!mark || !Number.isFinite(mark.price) || mark.price <= 0 || !Number.isFinite(Date.parse(mark.time)) || Date.parse(mark.time) > now || now - Date.parse(mark.time) > 15000)
      return { state: 'unknown' as const, equity: null, initial: null, maintenance: null, closeout: null, exposure: null, approximate: true };
    const q = p.quantity < 0n ? -p.quantity : p.quantity, notional = markedMicros(q, mark.price);
    const numerator = q * units(mark.price, 8), denominator = 10000000000n;
    const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
    equity += markedMicros(p.quantity, mark.price) - (p.quantity > 0n ? p.basis : -p.basis);
    exposure += notional;
    const market = markets.find(m => `${m.symbol}-USD` === symbol);
    const i = market?.min_initial_margin_fraction, m = market?.maintenance_margin_fraction, c = market?.closeout_margin_fraction;
    const valid = [i, m, c].every(n => Number.isInteger(n) && n >= 0 && n <= 10000) && c < m && m < i;
    // Missing metadata never creates a low maintenance threshold: require full selected initial margin.
    const selected = ceil(numerator, denominator * BigInt(p.leverage));
    const venueInitial = valid ? ceil(numerator * BigInt(i), denominator * 10000n) : 0n;
    initial += selected > venueInitial ? selected : venueInitial;
    if (valid) {
      maintenance += ceil(numerator * BigInt(m), denominator * 10000n);
      closeout += ceil(numerator * BigInt(c), denominator * 10000n);
    } else { approximate = true; maintenance += selected; closeout += selected; }
  }
  const state = equity < closeout ? 'closeout' as const : equity < maintenance ? 'liquidating' as const : equity < initial ? 'reduce-only' as const : 'healthy' as const;
  return { state, equity: dollars(equity), initial: dollars(initial), maintenance: dollars(maintenance), closeout: dollars(closeout), exposure: dollars(exposure), approximate };
}