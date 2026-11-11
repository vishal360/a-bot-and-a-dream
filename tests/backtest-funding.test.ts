import { test, expect } from 'bun:test';
import { replayStrategy } from '../src/backtest-replay';
import { replayFundingDigest, type FundingHistoryInput } from '../src/replay-funding';
import { StrategyRegistry } from '../src/strategies/registry';
import { fundingCarryV1 } from '../src/strategies/builtin';

const market = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4 };
const BASE = Date.parse('2026-10-27T00:00:00Z'), HOUR = 3600000;
const frame = (offset: number, nonce: number, size = '50.0000') => ({ wall: BASE + offset, mono: offset, raw: JSON.stringify({
  type: nonce === 1 ? 'subscribed/order_book' : 'update/order_book', channel: 'order_book:0', timestamp: BASE + offset,
  order_book: { code: 200, nonce, begin_nonce: nonce - 1, bids: [{ price: '100.00', size }], asks: [{ price: '100.02', size }] }
}) });
const stats = (offset: number) => ({ wall: BASE + offset, mono: offset, raw: JSON.stringify({
  type: 'update/market_stats', channel: 'market_stats:0', timestamp: BASE + offset,
  market_stats: { market_id: 0, symbol: 'BTC', index_price: '100.00', mark_price: '100.00', last_trade_price: '100.00', current_funding_rate: '0.99', funding_rate: '0.99', funding_timestamp: BASE + offset }
}) });
function history(to = HOUR * 2, value = '0.10000000', direction: 'long' | 'short' = 'long'): FundingHistoryInput {
  const result: FundingHistoryInput = { version: 1, market: { marketId: 0, symbol: 'BTC' }, resolution: '1h', from: BASE / 1000, to: (BASE + to) / 1000,
    observedAt: (BASE + to + HOUR) / 1000, source: 'https://mainnet.zklighter.elliot.ai/api/v1/fundings', sourceDigest: '',
    rows: Array.from({ length: Math.floor(to / HOUR) + 1 }, (_, i) => ({ timestamp: (BASE + i * HOUR) / 1000, value, direction })) };
  result.sourceDigest = replayFundingDigest(result); return result;
}
function runner(overrides: any = {}, side: 'buy' | 'sell' = 'sell', evaluate?: any) {
  const registry = new StrategyRegistry();
  registry.register({ ...fundingCarryV1, evaluate: evaluate ?? ((ctx: any) => ctx.position ? { action: 'hold', rationale: 'hold' } : { action: 'open', side, rationale: 'open' }) });
  return replayStrategy({ registry, strategyId: 'funding-carry-v1', params: { entryFundingPct: 0.0005, exitFundingPct: 0.0001, stopPct: 0.03 },
    market, frames: [frame(0, 1), frame(1000, 2), frame(HOUR * 2, 3)], staleMs: HOUR * 4, marketStats: true, capital: 10000, feeBps: 0, leverage: 1, notionalPerOrderUsd: side === 'buy' ? 1000.2 : 1000, ...overrides });
}

test('explicit hourly payer signs, no interpolation, events without frames, exact micro payment', () => {
  for (const side of ['buy', 'sell'] as const) for (const payer of ['long', 'short'] as const) {
    const result = runner({ fundingHistory: history(HOUR * 2, '0.10000001', payer) }, side);
    const pays = (side === 'buy') === (payer === 'long');
    expect(result.fundingUsd).toBe(pays ? -2.000002 : 2);
    expect(result.fundingEvents.map(e => e.paymentMicros)).toEqual(['0', pays ? '-1000001' : '1000000', pays ? '-1000001' : '1000000']);
    expect(result.equityTimeline.some(e => e.kind === 'funding' && Date.parse(e.time) === BASE + HOUR)).toBe(true);
    expect(result.fundingCoverage.economicModelComplete).toBe(true);
    expect(result.fundingCoverage.venueValidated).toBe(false);
    expect(result.fundingIneligible).toBe(true);
    expect(result.netPnl).toBeCloseTo(result.fundingUsd - 0.1, 8);
  }
});

test('missing history remains unknown and current stats NEVER adjust cash', () => {
  const result = runner({ frames: [frame(0, 1), stats(500), frame(1000, 2), stats(HOUR), stats(HOUR * 2)] });
  expect(result.fundingUsd).toBe(0); expect(result.fundingSamples).toBe(0);
  expect(result.fundingCoverage.status).toBe('unknown');
  expect(result.fundingCoverage.missingHours).toHaveLength(3);
  expect(result.fundingCoverage.economicModelComplete).toBe(false);
  expect(result.netPnl).toBeCloseTo(-0.1, 8); expect(result.fundingIneligible).toBe(true);
});

test('same-boundary opening is after funding and pays only next hour', () => {
  const result = runner({ frames: [frame(0, 1), frame(HOUR, 2), frame(HOUR * 2, 3)], fundingHistory: history() });
  expect(result.fundingEvents.map(e => e.paymentMicros)).toEqual(['0', '0', '1000000']);
});

test('same-boundary closing settles pre-boundary holdings; close allocates without double cash', () => {
  const result = runner({ frames: [frame(0, 1), frame(1000, 2), frame(HOUR, 3)], fundingHistory: history(HOUR) }, 'sell',
    (ctx: any) => ctx.position ? { action: 'close', fraction: 1, rationale: 'close' } : { action: 'open', side: 'sell', rationale: 'open' });
  expect(result.trades).toHaveLength(1); expect(result.trades[0].fundingUsd).toBe(1);
  expect(result.trades[0].pnl).toBeCloseTo(0.8, 8); expect(result.fundingUsd).toBe(1); expect(result.netPnl).toBeCloseTo(0.8, 8);
});

test('partial closes allocate accumulated funding proportionally with final remainder', () => {
  let calls = 0;
  const result = runner({ frames: [frame(0, 1), frame(1000, 2), frame(HOUR, 3), frame(HOUR + 1000, 4)], fundingHistory: history(HOUR + 1000, '0.10000001') }, 'buy',
    (ctx: any) => !ctx.position ? { action: 'open', side: 'buy', rationale: 'open' } : { action: 'close', fraction: ++calls === 1 ? 0.5 : 1, rationale: 'close' });
  expect(result.trades.map(t => t.fundingUsd)).toEqual([-0.500001, -0.5]);
  expect(result.trades.reduce((sum, t) => sum + t.pnl, 0)).toBeCloseTo(result.netPnl, 8);
  expect(result.netPnl).toBeCloseTo(-1.200001, 8);
});

test('later frames and future history never mutate earlier causal equity prefix, no beyond-end processing', () => {
  const frames = [frame(0, 1), frame(1000, 2)];
  const short = runner({ frames, fundingHistory: history() });
  const long = runner({ frames: [...frames, frame(HOUR * 2, 3)], fundingHistory: history() });
  expect(long.equity.slice(0, short.equity.length)).toEqual(short.equity);
  expect(long.equityTimeline.slice(0, short.equityTimeline.length)).toEqual(short.equityTimeline);
  expect(short.fundingEvents).toHaveLength(1); expect(short.fundingUsd).toBe(0);
});

test('historical funding evidence never enters future strategy context or alters pre-event decisions', () => {
  const contexts: any[] = [];
  const evaluate = (ctx: any) => { contexts.push(structuredClone(ctx)); return { action: 'hold', rationale: 'observe' }; };
  const frames = [frame(0, 1), frame(1000, 2)];
  runner({ frames, fundingHistory: history(HOUR * 2, '1.00000000') }, 'buy', evaluate);
  const withHistory = contexts.splice(0);
  runner({ frames }, 'buy', evaluate);
  expect(contexts).toEqual(withHistory);
  expect(Object.keys(contexts[0])).not.toContain('fundingHistory');
});

test('zero hours count as required evidence, explicit zero changes no cash', () => {
  const result = runner({ fundingHistory: history(HOUR * 2, '0.00000000') });
  expect(result.fundingSamples).toBe(3); expect(result.fundingUsd).toBe(0);
  expect(result.fundingCoverage.missingHours).toEqual([]);
});

const malformed: [string, (h: FundingHistoryInput) => void][] = [
  ['duplicate', h => h.rows[1] = { ...h.rows[0] }], ['gap', h => h.rows.splice(1, 1)],
  ['wrong market', h => h.market.marketId = 1], ['wrong symbol', h => h.market.symbol = 'ETH'],
  ['nonfinal', h => h.observedAt--], ['milliseconds', h => h.rows[1].timestamp *= 1000],
  ['unaligned', h => h.rows[1].timestamp++], ['out of interval', h => h.rows[0].timestamp -= 3600],
  ['negative', h => h.rows[1].value = '-1'], ['precision', h => h.rows[1].value = '0.123456789'],
  ['exponent', h => h.rows[1].value = '1e-3'], ['numeric units', h => (h.rows[1] as any).value = 1],
  ['direction', h => (h.rows[1] as any).direction = 'receive'], ['coverage', h => h.from += 1],
  ['unbounded', h => h.to += HOUR * 1000], ['bad digest', h => h.sourceDigest = '0'.repeat(64)],
];
for (const [name, mutate] of malformed) test(`reject malformed funding evidence: ${name}`, () => {
  const h = history(); mutate(h);
  if (name !== 'bad digest') h.sourceDigest = replayFundingDigest(h);
  expect(() => runner({ fundingHistory: h })).toThrow();
});

test('digest is stable over key and row order but source content changes invalidate it', () => {
  const h = history(); const digest = h.sourceDigest; h.rows.reverse();
  expect(replayFundingDigest(h)).toBe(digest); expect(runner({ fundingHistory: h }).fundingSamples).toBe(3);
  h.rows[0].value = '0'; expect(() => runner({ fundingHistory: h })).toThrow('digest');
});
