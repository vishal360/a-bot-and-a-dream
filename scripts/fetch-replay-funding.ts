/** Read-only public history export. No keys, account endpoints or trading imports. */
import { resolve } from 'node:path';
import { mkdirSync, linkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { replayFundingDigest, validateFundingHistory, type ReplayFundingHistory } from '../src/replay-funding';
import { publicFundingRows } from './lighter-funding-evidence';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: bun run scripts/fetch-replay-funding.ts --market-id N --symbol BTC --from EPOCH_SECONDS --to EPOCH_SECONDS --out PATH\nPublic mainnet funding history only. Maximum 30-day span. Does not verify venue eligibility/rounding or authorize trading. Existing files are never overwritten.');
  process.exit(0);
}
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!['--market-id', '--symbol', '--from', '--to', '--out'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate or missing argument');
  values.set(key, value);
}
if (values.size !== 5) throw new Error('All five arguments are required; use --help');
const marketId = Number(values.get('--market-id')), symbol = values.get('--symbol')!;
const from = Number(values.get('--from')), to = Number(values.get('--to'));
if (![marketId, from, to].every(n => Number.isSafeInteger(n) && n >= 0) || to < from || to - from > 30 * 86400 || !/^[A-Za-z0-9._/-]{1,80}$/.test(symbol)) throw new Error('Invalid market, symbol or bounded timestamps');
const output = resolve(values.get('--out')!);
if (existsSync(output) || existsSync(output + '.tmp')) throw new Error('Output already exists; refusing overwrite');
const endpoint = new URL('https://mainnet.zklighter.elliot.ai/api/v1/fundings');
endpoint.search = new URLSearchParams({ market_id: String(marketId), resolution: '1h', start_timestamp: String(Math.floor(from / 3600) * 3600), end_timestamp: String(Math.ceil(to / 3600) * 3600), count_back: '0' }).toString();
const response = await fetch(endpoint, { signal: AbortSignal.timeout(20000), redirect: 'error' });
if (!response.ok) throw new Error(`Public funding history HTTP ${response.status}`);
if (!response.body) throw new Error('Missing funding response body');
const reader = response.body.getReader(), chunks: Uint8Array[] = [];
let bytes = 0;
try {
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('History response exceeds 2MiB'); }
    chunks.push(value);
  }
} finally { reader.releaseLock(); }
const text = Buffer.concat(chunks).toString('utf8');
const rows = publicFundingRows(JSON.parse(text)).filter(row => row.timestamp >= from && row.timestamp <= to)
  .map(({ timestamp, value, direction }) => ({ timestamp, value, direction })).sort((a, b) => a.timestamp - b.timestamp);
const payload = { version: 1 as const, market: { marketId, symbol }, from, to, observedAt: Math.floor(Date.now() / 1000), resolution: '1h' as const,
  source: endpoint.toString(), rows };
const history: ReplayFundingHistory = { ...payload, sourceDigest: replayFundingDigest(payload) };
validateFundingHistory(history, { market_id: marketId, symbol }, from, to);
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
try {
  writeFileSync(temporary, JSON.stringify(history, null, 2) + '\n', { flag: 'wx' });
  // Atomic publication without replacing an output created by a competing exporter.
  linkSync(temporary, output);
} finally {
  // Exact unique temporary path above, never the user output or another process file.
  if (existsSync(temporary)) unlinkSync(temporary);
}
console.log(JSON.stringify({ output, rows: rows.length, sourceDigest: history.sourceDigest, venueCorroborated: false, canPromote: false,
  note: 'Public history bytes and declared collection time are evidence inputs, not account-payment/eligibility or finality verification. Replay validation refuses gaps and nonfinal event windows.' }, null, 2));
