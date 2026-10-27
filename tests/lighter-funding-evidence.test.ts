import { test, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compareFundingEvidence, positionFundingRows, publicFundingRows, type PositionFundingRow } from '../scripts/lighter-funding-evidence';

const hour = 1791860400;
const publicRow = { timestamp: hour, value: '0.5', rate: '0.0010', direction: 'long' as const };
const position: PositionFundingRow = { timestamp: hour, market_id: 1, funding_id: 10, change: '-1.000000', discount: '0.000000', rate: '0.000010', position_size: '2', position_side: 'long' };
const history = (row = publicRow) => new Map([[1, [row]]]);
const compare = (row: PositionFundingRow = position) => compareFundingEvidence([row], history())[0];

test('funding evidence accepts signed account data separately from public magnitudes', () => {
  expect(publicFundingRows({ code: 200, resolution: '1h', fundings: [publicRow] })).toEqual([publicRow]);
  expect(positionFundingRows({ code: 200, position_fundings: [position], next_cursor: 'opaque' }, [1])).toEqual([position]);
  const result = compare();
  expect(result.status).toBe('candidate-consistent');
  if ('candidatePayment' in result) {
    expect(result.candidatePayment).toBe('-1.000000000000000000000000000000000000');
    expect(result.ratePercentCandidateMatches).toBe(true);
  }
});

test('both paying directions and both position sides are compared without floats', () => {
  for (const direction of ['long', 'short'] as const) for (const side of ['long', 'short'] as const) {
    const row = { ...position, position_side: side, change: side === direction ? '-1' : '1', rate: direction === 'long' ? '0.000010' : '-0.000010' };
    const result = compareFundingEvidence([row], new Map([[1, [{ ...publicRow, direction }]]]))[0];
    expect(result.status).toBe('candidate-consistent');
  }
});

test('evidence tolerance is declared and bounded; mismatch never changes account amounts', () => {
  const inside = compare({ ...position, change: '-1.00000102' });
  const outside = compare({ ...position, change: '-1.000001020000000001' });
  expect(inside.status).toBe('candidate-consistent');
  expect(outside.status).toBe('candidate-mismatch');
  expect(outside.accountChange).toBe('-1.000001020000000001');
  expect(position.change).toBe('-1.000000');
});

test('percent/fraction disagreement is a candidate mismatch even when amount agrees', () => {
  const result = compare({ ...position, rate: '0.0010' });
  expect(result.status).toBe('candidate-mismatch');
  if ('ratePercentCandidateMatches' in result) expect(result.ratePercentCandidateMatches).toBe(false);
});

test('nonzero discounts are unmodeled, never guessed away', () => {
  expect(compare({ ...position, discount: '0.000001' }).status).toBe('discount-unmodeled');
});

test('missing public hour or market never shifts timestamp to invent a match', () => {
  for (const row of [{ ...position, timestamp: hour + 3600 }, { ...position, market_id: 0 }]) {
    expect(compare(row).status).toBe('public-hour-unavailable');
  }
});

test('public history rejects duplicate, unaligned, unsafe and malformed identities', () => {
  for (const fundings of [[publicRow, publicRow], [{ ...publicRow, timestamp: hour + 1 }], [{ ...publicRow, timestamp: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...publicRow, direction: 'unknown' }], [{ ...publicRow, timestamp: -3600 }], Array(751).fill(publicRow)]) {
    expect(() => publicFundingRows({ code: 200, resolution: '1h', fundings })).toThrow();
  }
  for (const body of [null, { code: 200, resolution: '1d', fundings: [publicRow] }, { code: 401, resolution: '1h', fundings: [publicRow] }]) {
    expect(() => publicFundingRows(body)).toThrow();
  }
});

test('public magnitudes require bounded exact decimal strings, not signed account rates', () => {
  for (const value of ['-1', '1e-8', 'NaN', '0.0000000000000000001', '1'.repeat(61), 0.5, null]) {
    expect(() => publicFundingRows({ code: 200, resolution: '1h', fundings: [{ ...publicRow, value }] })).toThrow();
  }
  expect(() => publicFundingRows({ code: 200, resolution: '1h', fundings: [{ ...publicRow, rate: '-0.01' }] })).toThrow();
});

test('account evidence rejects duplicate funding IDs and duplicate market/hour rows', () => {
  for (const rows of [[position, position], [position, { ...position, timestamp: hour + 3600 }], [position, { ...position, funding_id: 11 }]]) {
    expect(() => positionFundingRows({ code: 200, position_fundings: rows }, [1])).toThrow();
  }
  expect(positionFundingRows({ code: 200, position_fundings: [position, { ...position, market_id: 0, funding_id: 11 }] }, [0, 1])).toHaveLength(2);
});

test('account evidence is scoped and rejects negative size/discount and unsafe IDs', () => {
  for (const row of [{ ...position, market_id: 2 }, { ...position, funding_id: Number.MAX_SAFE_INTEGER + 1 }, { ...position, timestamp: hour + 1 },
    { ...position, position_size: '-1' }, { ...position, discount: '-0.1' }, { ...position, position_side: 'unknown' }, { ...position, change: 'NaN' }]) {
    expect(() => positionFundingRows({ code: 200, position_fundings: [row] }, [1])).toThrow();
  }
  for (const next_cursor of [123, 'x'.repeat(2049), null]) expect(() => positionFundingRows({ code: 200, position_fundings: [position], next_cursor }, [1])).toThrow();
  expect(() => positionFundingRows({ code: 200, position_fundings: Array(101).fill(position) }, [1])).toThrow();
});

test('arithmetic comparison exposes no readiness, finality or execution approval', () => {
  const result = compare();
  for (const key of ['eligibilityVerified', 'boundaryOrderingVerified', 'finalityVerified', 'automationAuthorized', 'executionEnabled']) expect(result).not.toHaveProperty(key);
  expect(result.status).toBe('candidate-consistent');
});

test('public-pool CLI help and forbidden account/auth flags are offline', async () => {
  const path = fileURLToPath(new URL('../scripts/corroborate-lighter-funding.ts', import.meta.url));
  for (const [args, code] of [[['--help'], 0], [['--account-index', '1'], 1], [['--authorization', 'fixture'], 1], [['--live'], 1]] as const) {
    const child = Bun.spawn([process.execPath, path, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(code);
    if (!code) expect(stdout).toContain('never eligibility, ordering or finality');
    else expect(stderr).toContain('No account/authentication arguments accepted');
  }
});