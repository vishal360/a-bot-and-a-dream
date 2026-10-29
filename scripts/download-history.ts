/** Historical market-data backfill (docs/HISTORY_BACKFILL.md).
 *
 *  Downloads public REST klines — default: Binance SPOT 1-second candles via
 *  data-api.binance.vision (the official public market-data mirror; no API key, no auth,
 *  no account) — into data/history/binance-spot-<SYMBOL>-<INTERVAL>/<UTC-day>.jsonl plus
 *  meta.json. Resumable (existing day files are skipped), polite (sequential requests,
 *  small delay, retries with backoff), atomic writes. Optional funding history from the
 *  futures API; if funding is unavailable (e.g. geo-blocked) the download still succeeds
 *  WITHOUT funding and records why — funding-dependent strategies then see no signal.
 *
 *  This data is a DIFFERENT VENUE than Lighter: it screens candidates, it can never
 *  promote a strategy (see scripts/research-walkforward.ts).
 *
 *  Usage:
 *    bun run scripts/download-history.ts --symbol BTCUSDT --days 30 [--interval 1s]
 *        [--end 2026-10-30] [--funding] [--api https://data-api.binance.vision]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Kline } from '../src/backtest-klines';

/** Parse and validate one raw kline row from the venue REST response. */
export function parseKlineRow(row: unknown): Kline {
  if (!Array.isArray(row) || row.length < 7) throw new Error('Invalid kline row');
  const openTime = Number(row[0]);
  const prices = [Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4])];
  const volume = Number(row[5]);
  const closeTime = Number(row[6]);
  if (!Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime) || closeTime < openTime ||
      prices.some(v => !Number.isFinite(v) || v <= 0) || !Number.isFinite(volume) || volume < 0) throw new Error('Invalid kline values');
  return { openTime, open: prices[0], high: prices[1], low: prices[2], close: prices[3], volume, closeTime };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : null;
  };
  const symbol = arg('symbol') ?? 'BTCUSDT';
  const interval = arg('interval') ?? '1s';
  const days = Number(arg('days') ?? 30);
  const endIso = arg('end');
  const wantFunding = args.includes('--funding');
  const api = arg('api') ?? 'https://data-api.binance.vision';
  const fundingApi = 'https://fapi.binance.com';
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error('Invalid symbol');
  if (!['1s', '1m'].includes(interval)) throw new Error('Only 1s/1m intervals are supported');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be 1..365');

  const root = resolve('data', 'history', `binance-spot-${symbol}-${interval}`);
  mkdirSync(root, { recursive: true });
  const endMs = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(endMs)) throw new Error('Invalid --end');
  const dayMs = 86400000;
  const stepMs = interval === '1s' ? 1000 : 60000;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function getJson(url: string, tries = 4): Promise<any> {
    for (let attempt = 1; attempt <= tries; attempt++) {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      if (response.status === 429 || response.status >= 500) { await sleep(500 * attempt * attempt); continue; }
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    throw new Error(`Gave up after ${tries} tries: ${url}`);
  }

  const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let totalCandles = 0, requests = 0, daysWritten = 0;

  for (let d = 0; d < days; d++) {
    const dayStart = Math.floor((endMs - (d + 1) * dayMs) / dayMs) * dayMs;
    if (dayStart >= endMs) continue;
    const day = utcDay(dayStart);
    const file = join(root, `${day}.jsonl`);
    if (existsSync(file)) {
      totalCandles += readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      continue;
    }
    const klines: Kline[] = [];
    let cursor = dayStart;
    const dayEnd = dayStart + dayMs;
    while (cursor < dayEnd) {
      const url = `${api}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${dayEnd - 1}&limit=1000`;
      const rows = await getJson(url);
      requests++;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) klines.push(parseKlineRow(row));
      cursor = (rows[rows.length - 1] as unknown[])[0] as number + stepMs;
      if (rows.length < 1000) break;
      await sleep(150);
    }
    if (klines.length) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, klines.map(k => JSON.stringify(k)).join('\n') + '\n');
      renameSync(tmp, file);
      totalCandles += klines.length;
      daysWritten++;
      console.log(`${day}: ${klines.length} candles`);
    }
    await sleep(150);
  }

  // Optional funding history (futures API): a signal for funding-carry screening only.
  let funding: { time: number; rate: number }[] = [];
  let fundingNote = 'not requested';
  if (wantFunding) {
    try {
      const start = endMs - days * dayMs;
      let cursor = start;
      for (let page = 0; page < 10; page++) {
        const rows = await getJson(`${fundingApi}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`);
        requests++;
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
          const time = Number(r.fundingTime), rate = Number(r.fundingRate);
          if (Number.isSafeInteger(time) && Number.isFinite(rate)) funding.push({ time, rate });
        }
        if (rows.length < 1000) break;
        cursor = Number((rows[rows.length - 1] as any).fundingTime) + 1;
      }
      funding = funding.filter((f, i, all) => i === 0 || f.time !== all[i - 1].time);
      fundingNote = `${funding.length} events`;
    } catch (error) {
      funding = [];
      fundingNote = `unavailable (${(error as Error).message}); funding-dependent strategies will see no signal`;
    }
  }

  writeFileSync(join(root, 'meta.json'), JSON.stringify({
    version: 1, source: 'binance-spot-rest', api, symbol, interval, days, endMs,
    candles: totalCandles, requests, daysWritten, funding: fundingNote,
    generatedAt: new Date().toISOString(),
  }, null, 1) + '\n');
  if (funding.length) writeFileSync(join(root, 'funding.jsonl'), funding.map(f => JSON.stringify(f)).join('\n') + '\n');
  console.log(`done: ${totalCandles} candles across ${daysWritten} day file(s) in ${root} (${requests} requests); funding: ${fundingNote}`);
}

if (import.meta.main) await main();
