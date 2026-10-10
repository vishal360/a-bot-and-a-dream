import { test, expect } from 'bun:test';
import { units, matchIOC } from '../src/paper-math';

test('decimal units are exact and reject unsupported precision and overflow', () => {
  expect(units(.00000001, 8)).toBe(1n);
  expect(units('0.01000', 2)).toBe(1n);
  expect(() => units(.000001, 5)).toThrow('precision');
  expect(() => units(NaN, 5)).toThrow();
  expect(() => units(1, undefined as any)).toThrow();
  expect(() => units('9007199254740992', 0)).toThrow('overflow');
});

test('IOC sums integer lots, records depth legs and conservatively settles fees', () => {
  const result = matchIOC('buy', .03, [{ price: 101, quantity: .01 }, { price: 101.2, quantity: .01 }], 5, 2, 2);
  expect(result.filled).toBe(.02); expect(result.canceled).toBe(.01);
  expect(result.price).toBe(101.1); expect(result.quoteMicros).toBe('2022000');
  expect(result.feeMicros).toBe('405'); expect(result.executions).toHaveLength(2);
  const tiny = [{ price: 1.01, quantity: .00001 }];
  expect(matchIOC('buy', .00001, tiny, 5, 2, 2).quoteMicros).toBe('11');
  expect(matchIOC('sell', .00001, tiny, 5, 2, 2).quoteMicros).toBe('10');
  expect(matchIOC('buy', .00001, tiny, 5, 2, 2).feeMicros).toBe('1');
});

test('collar boundaries use integer comparison and invalid economics fail closed', () => {
  const levels = [{ price: 100, quantity: .01 }, { price: 100.5, quantity: .01 }, { price: 100.51, quantity: .01 }];
  expect(matchIOC('buy', .03, levels, 5, 2, 2).filled).toBe(.02);
  expect(() => matchIOC('buy', .01, levels, 5, 2, NaN)).toThrow();
  expect(() => matchIOC('buy', .010001, levels, 5, 2, 2)).toThrow('precision');
});