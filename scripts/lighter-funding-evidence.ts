// Evidence analysis only. No Paper/Store imports or readiness writes.
const SCALE = 10n ** 18n;
const MICRO = 10n ** 30n; // One millionth at the product's 36-decimal scale.

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 60 || !/^-?\d+(?:\.\d{1,18})?$/.test(value)) throw new Error('Invalid evidence decimal');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (negative ? -1n : 1n) * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0')));
}
const absolute = (n: bigint) => n < 0n ? -n : n;
function text(n: bigint, places = 36): string {
  const digits = absolute(n).toString().padStart(places + 1, '0');
  return `${n < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

export type PublicFundingRow = { timestamp: number; value: string; rate: string; direction: 'long' | 'short' };
export type PositionFundingRow = { timestamp: number; market_id: number; funding_id: number; change: string; discount: string; rate: string; position_size: string; position_side: 'long' | 'short' };
const identity = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function publicFundingRows(body: any): PublicFundingRow[] {
  if (body?.code !== 200 || body.resolution !== '1h' || !Array.isArray(body.fundings) || body.fundings.length > 750) throw new Error('Invalid public funding response');
  const times = new Set<number>();
  for (const row of body.fundings) {
    if (!identity(row?.timestamp) || row.timestamp % 3600 || times.has(row.timestamp) || !['long', 'short'].includes(row.direction)) throw new Error('Invalid public funding identity');
    if (decimal(row.value) < 0n || decimal(row.rate) < 0n) throw new Error('Negative public funding magnitude');
    times.add(row.timestamp);
  }
  return body.fundings;
}

export function positionFundingRows(body: any, markets: number[]): PositionFundingRow[] {
  if (body?.code !== 200 || !Array.isArray(body.position_fundings) || body.position_fundings.length > 100 ||
      (body.next_cursor !== undefined && (typeof body.next_cursor !== 'string' || body.next_cursor.length > 2048))) throw new Error('Invalid position funding response');
  const ids = new Set<number>(), times = new Set<string>();
  for (const row of body.position_fundings) {
    const key = `${row?.market_id}:${row?.timestamp}`;
    if (!identity(row?.timestamp) || row.timestamp % 3600 || !identity(row.market_id) || !markets.includes(row.market_id) || !identity(row.funding_id) ||
        ids.has(row.funding_id) || times.has(key) || !['long', 'short'].includes(row.position_side)) throw new Error('Invalid position funding identity');
    decimal(row.change); decimal(row.rate);
    if (decimal(row.position_size) < 0n || decimal(row.discount) < 0n) throw new Error('Negative position size or discount');
    ids.add(row.funding_id); times.add(key);
  }
  return body.position_fundings;
}

/** A candidate interpretation, not a settlement/finality/rounding specification. */
export function compareFundingEvidence(rows: PositionFundingRow[], histories: Map<number, PublicFundingRow[]>) {
  return rows.map(row => {
    const history = histories.get(row.market_id)?.find(h => h.timestamp === row.timestamp);
    const base = { marketId: row.market_id, timestamp: row.timestamp, fundingId: row.funding_id, positionSide: row.position_side, positionSize: row.position_size,
      accountChange: row.change, accountRate: row.rate, accountDiscount: row.discount };
    if (!history) return { ...base, status: 'public-hour-unavailable' as const };
    const quantity = decimal(row.position_size), value = decimal(history.value), account = decimal(row.change) * SCALE;
    const candidate = (row.position_side === history.direction ? -1n : 1n) * quantity * value;
    // Declared engineering tolerance: 1 micro quote unit + quantity * 1e-8.
    // This accommodates an 8-decimal public value; it is NOT the venue rounding policy.
    const tolerance = MICRO + quantity * 10n ** 10n;
    const difference = account - candidate;
    const rateMatches = decimal(row.rate) * 100n === (history.direction === 'short' ? -1n : 1n) * decimal(history.rate);
    const discountUnmodeled = decimal(row.discount) !== 0n;
    return { ...base, publicValue: history.value, publicRate: history.rate, publicDirection: history.direction,
      candidatePayment: text(candidate), difference: text(difference), tolerance: text(tolerance), ratePercentCandidateMatches: rateMatches,
      status: discountUnmodeled ? 'discount-unmodeled' as const : absolute(difference) <= tolerance && rateMatches ? 'candidate-consistent' as const : 'candidate-mismatch' as const };
  });
}