import { test, expect } from 'bun:test';
import { inferFundingCadence } from '../src/funding-analysis';

const HOUR = 3600 * 1000;

test('authoritative cadence: distinct funding_timestamps give the venue schedule', () => {
  const samples = [
    { t: 0, rate: 0.001, fundingTimestamp: 0 },
    { t: 60, rate: 0.001, fundingTimestamp: 0 },
    { t: 120, rate: 0.0012, fundingTimestamp: HOUR },
    { t: 300, rate: 0.0012, fundingTimestamp: HOUR },
    { t: 400, rate: 0.0009, fundingTimestamp: 2 * HOUR },
    { t: 500, rate: 0.0009, fundingTimestamp: 3 * HOUR },
  ];
  const cadence = inferFundingCadence(samples);
  expect(cadence.authoritative).toBe(true);
  expect(cadence.inferredCadenceHours).toBe(1);
  expect(cadence.timestampIntervalsMs).toEqual([HOUR, HOUR, HOUR]);
  expect(cadence.distinctRates).toBe(3);
  expect(cadence.changes).toBe(2);
});

test('fallback cadence: rate changes only, marked non-authoritative', () => {
  const samples = [
    { t: 0, rate: 0.001, fundingTimestamp: null },
    { t: 60, rate: 0.001, fundingTimestamp: null },
    { t: 120, rate: 0.0012, fundingTimestamp: null },
    { t: 180, rate: 0.0012, fundingTimestamp: null },
    { t: 240 + 4 * HOUR, rate: 0.0009, fundingTimestamp: null },
    { t: 300 + 8 * HOUR, rate: 0.0011, fundingTimestamp: null },
  ];
  const cadence = inferFundingCadence(samples);
  expect(cadence.authoritative).toBe(false);
  expect(cadence.changes).toBe(3);
  expect(cadence.inferredCadenceHours).toBeGreaterThan(1); // changes are 4h and 4h apart
});

test('nonsense input is rejected, empty input yields honest nulls', () => {
  expect(() => inferFundingCadence([])).not.toThrow();
  const empty = inferFundingCadence([]);
  expect(empty.inferredCadenceHours).toBeNull();
  expect(empty.samples).toBe(0);
  // @ts-expect-error deliberate misuse
  expect(() => inferFundingCadence('nope')).toThrow('sample array');
});
