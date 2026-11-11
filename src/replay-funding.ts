import { createHash } from 'node:crypto';
import { units } from './paper-math';

export const FUNDING_HOUR_SECONDS = 3600;
export const MAX_FUNDING_HOURS = 750;
export type ReplayFundingRow = { timestamp: number; value: string; direction: 'long' | 'short' };
/** Public history is historical accounting input, never a strategy feature or venue attestation.
 * from/to/observedAt and row timestamps are epoch SECONDS; coverage is inclusive.
 * observedAt is the collector's claimed observation time, not an onchain finality proof.
 */
export type FundingHistoryInput = {
  version: 1; market: { marketId: number; symbol: string }; resolution: '1h';
  from: number; to: number; observedAt: number;
  source: string; sourceDigest: string; rows: ReplayFundingRow[];
};
export type ReplayFundingHistory = FundingHistoryInput;
export type FundingCoverage = {
  status: 'complete' | 'unknown'; requiredHours: number[]; missingHours: number[];
  sourceDigest: string | null; economicModelComplete: boolean;
  independentlyCorroborated: false; venueValidated: false; liveApproved: false;
};
const seconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000;
/** Canonical, order-independent source identity. A digest detects changes, not source authenticity. */
export function replayFundingDigest(input: Omit<FundingHistoryInput, 'sourceDigest'> | FundingHistoryInput): string {
  return createHash('sha256').update(JSON.stringify({ version: input.version,
    market: { marketId: input.market.marketId, symbol: input.market.symbol }, resolution: input.resolution,
    from: input.from, to: input.to, observedAt: input.observedAt, source: input.source,
    rows: input.rows.map(r => ({ timestamp: r.timestamp, value: r.value, direction: r.direction })).sort((a, b) => a.timestamp - b.timestamp)
  })).digest('hex');
}
export function requiredFundingHours(from: number, to: number): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) throw new Error('Invalid funding replay interval');
  const first = Math.ceil(from / FUNDING_HOUR_SECONDS) * FUNDING_HOUR_SECONDS;
  const count = Math.max(0, Math.floor((to - first) / FUNDING_HOUR_SECONDS) + 1);
  if (count > MAX_FUNDING_HOURS) throw new Error('Funding history exceeds bounded 750-hour interval');
  return Array.from({ length: count }, (_, i) => first + i * FUNDING_HOUR_SECONDS);
}
/** Strict full-coverage evidence admission. Missing/duplicate/nonfinal/mismatched evidence throws;
 * absence is separately unknown. One-hour observation lag is a simulator policy only. */
export function validateFundingHistory(input: FundingHistoryInput | undefined, market: { market_id: number; symbol: string }, from: number, to: number): { coverage: FundingCoverage; rows: ReplayFundingRow[] } {
  const requiredHours = requiredFundingHours(from, to);
  if (input !== undefined && (input === null || typeof input !== 'object')) throw new Error('Invalid funding history envelope');
  const coverage: FundingCoverage = { status: input ? 'complete' : 'unknown', requiredHours,
    missingHours: input ? [] : requiredHours, sourceDigest: input?.sourceDigest ?? null,
    economicModelComplete: !!input, independentlyCorroborated: false, venueValidated: false, liveApproved: false };
  if (!input) return { coverage, rows: [] };
  if (input.version !== 1 || input.resolution !== '1h' || input.market?.marketId !== market.market_id || input.market?.symbol !== market.symbol ||
      !seconds(input.from) || !seconds(input.to) || !seconds(input.observedAt) || input.to < input.from || input.to - input.from > MAX_FUNDING_HOURS * FUNDING_HOUR_SECONDS ||
      input.from > from || input.to < to || typeof input.source !== 'string' || input.source.length > 2048 || !/^https:\/\/[^\s]+$/.test(input.source) ||
      typeof input.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || !Array.isArray(input.rows) || input.rows.length > MAX_FUNDING_HOURS) throw new Error('Invalid funding history envelope/market/coverage');
  const expected = requiredFundingHours(input.from, input.to), seen = new Set<number>();
  for (const row of input.rows) {
    if (!row || !seconds(row.timestamp) || row.timestamp % FUNDING_HOUR_SECONDS !== 0 || row.timestamp < input.from || row.timestamp > input.to || seen.has(row.timestamp)) throw new Error('Invalid or duplicate funding hour');
    if (row.timestamp + FUNDING_HOUR_SECONDS > input.observedAt) throw new Error('Nonfinal funding hour under one-hour observation policy');
    if (row.direction !== 'long' && row.direction !== 'short') throw new Error('Invalid funding payer direction');
    if (typeof row.value !== 'string' || row.value.length > 32 || !/^\d+(?:\.\d{1,8})?$/.test(row.value)) throw new Error('Invalid funding value: nonnegative USDC per base unit, at most 8 decimals required');
    units(row.value, 8);
    seen.add(row.timestamp);
  }
  if (expected.length !== seen.size || expected.some(t => !seen.has(t))) throw new Error('Missing funding hours (zero hours must be explicit)');
  if (replayFundingDigest(input) !== input.sourceDigest) throw new Error('Funding source digest mismatch');
  return { coverage, rows: input.rows.filter(r => r.timestamp >= from && r.timestamp <= to).sort((a, b) => a.timestamp - b.timestamp).map(r => ({ ...r })) };
}
