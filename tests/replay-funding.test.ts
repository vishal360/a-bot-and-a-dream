import { test, expect } from 'bun:test';
import { requiredFundingHours, validateFundingHistory, replayFundingDigest, type FundingHistoryInput } from '../src/replay-funding';

const market = { market_id: 0, symbol: 'BTC' };
const history = (): FundingHistoryInput => {
  const h: FundingHistoryInput = { version: 1, market: { marketId: 0, symbol: 'BTC' }, resolution: '1h', from: 1, to: 7201, observedAt: 10800,
    source: 'https://example.invalid/public-history', sourceDigest: '', rows: [{ timestamp: 3600, value: '0', direction: 'long' }, { timestamp: 7200, value: '0.00000001', direction: 'short' }] };
  h.sourceDigest = replayFundingDigest(h); return h;
};

test('inclusive interval enumerates every aligned boundary without inventing fractional hours', () => {
  expect(requiredFundingHours(1, 7201)).toEqual([3600, 7200]);
  expect(requiredFundingHours(3600, 3600)).toEqual([3600]);
  expect(requiredFundingHours(3600.001, 7199.999)).toEqual([]);
  expect(() => requiredFundingHours(0, 750 * 3600)).toThrow('bounded');
});

test('one-hour observation lag accepts exact boundary; it is not independent corroboration', () => {
  const { coverage, rows } = validateFundingHistory(history(), market, 1, 7201);
  expect(rows).toHaveLength(2); expect(coverage.economicModelComplete).toBe(true);
  expect(coverage.independentlyCorroborated).toBe(false); expect(coverage.liveApproved).toBe(false);
  const h = history(); h.observedAt--; h.sourceDigest = replayFundingDigest(h);
  expect(() => validateFundingHistory(h, market, 1, 7201)).toThrow('Nonfinal');
});

test('absence is unknown even for sub-hour interval without boundaries; null is malformed not absent', () => {
  const result = validateFundingHistory(undefined, market, 1, 2);
  expect(result.coverage.status).toBe('unknown'); expect(result.coverage.economicModelComplete).toBe(false);
  expect(result.coverage.missingHours).toEqual([]);
  expect(() => validateFundingHistory(null as any, market, 1, 2)).toThrow();
});

test('broader evidence fully validates but only returns replay-window events', () => {
  const result = validateFundingHistory(history(), market, 3599.5, 3600);
  expect(result.rows.map(r => r.timestamp)).toEqual([3600]);
  const h = history(); h.rows[1].value = 'bad'; h.sourceDigest = replayFundingDigest(h);
  expect(() => validateFundingHistory(h, market, 3599.5, 3600)).toThrow();
});

test('safe units and bounded source metadata reject ambiguity', () => {
  for (const mutate of [
    (h: FundingHistoryInput) => h.rows[0].value = '99999999999999999999999999999999',
    (h: FundingHistoryInput) => h.source = '',
    (h: FundingHistoryInput) => h.source = 'https://' + 'x'.repeat(2048),
    (h: FundingHistoryInput) => h.from = 0.1,
    (h: FundingHistoryInput) => h.resolution = '8h' as any,
    (h: FundingHistoryInput) => h.observedAt = Infinity,
  ]) {
    const h = history(); mutate(h); h.sourceDigest = replayFundingDigest(h);
    expect(() => validateFundingHistory(h, market, 1, 7201)).toThrow();
  }
});
