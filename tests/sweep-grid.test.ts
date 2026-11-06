import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { parseGrid, buildAttempts, attemptsToJsonl, builtinRegistry } from '../src/sweep-grid';

test('parseGrid: keys, multiple values, decimals, errors', () => {
  expect(parseGrid('lookback=20,50,100;stopPct=0.005,0.01')).toEqual({ lookback: [20, 50, 100], stopPct: [0.005, 0.01] });
  expect(parseGrid('a=1')).toEqual({ a: [1] });
  expect(() => parseGrid('')).toThrow('Empty grid');
  expect(() => parseGrid('noequals')).toThrow('expected key=v1,v2');
  expect(() => parseGrid('a=1;a=2')).toThrow('Duplicate');
  expect(() => parseGrid('a=x,y')).toThrow('Invalid grid value');
  expect(() => parseGrid('9bad=1')).toThrow('Invalid grid key');
});

test('buildAttempts: cartesian product in key order, validated against the strategy', () => {
  const registry = builtinRegistry();
  const strategy = registry.get('breakout-v1');
  const spec = Object.fromEntries(strategy.params.map(p => [p.key, [p.default, p.min]]));
  const attempts = buildAttempts(strategy, spec);
  const expected = strategy.params.reduce((acc, p) => acc * 2, 1);
  expect(attempts).toHaveLength(expected);
  expect(attempts[0].strategyId).toBe('breakout-v1');
  // Every attempt must pass the strategy's own parameter validation.
  for (const a of attempts) expect(() => require('../src/strategies/types').validateParams(strategy, a.params)).not.toThrow();
});

test('buildAttempts: unknown keys and out-of-range values fail the sweep honestly', () => {
  const registry = builtinRegistry();
  const strategy = registry.get('breakout-v1');
  expect(() => buildAttempts(strategy, { noSuchParam: [1] })).toThrow('not in breakout-v1');
  expect(() => buildAttempts(strategy, Object.fromEntries(strategy.params.map(p => [p.key, [p.max * 10]])))).toThrow();
});

test('attemptsToJsonl: one JSON object per line, trailing newline', () => {
  const lines = attemptsToJsonl([
    { strategyId: 'a', params: { x: 1 } },
    { strategyId: 'a', params: { x: 2 } },
  ]);
  expect(lines).toBe('{"strategyId":"a","params":{"x":1}}\n{"strategyId":"a","params":{"x":2}}\n');
  expect(lines.trim().split('\n').every(l => { JSON.parse(l); return true; })).toBe(true);
});
