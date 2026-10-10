import { test, expect } from 'bun:test';
import { LighterMarkets } from '../src/lighter';
test('Lighter quotes distinguish networks, reject invalid prices and retain stale status', async () => {
  let fail = false;
  const request = (async (url: any) => fail ? Response.json({}, { status: 503 }) : Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: String(url).includes('testnet') ? 4096 : 1, mark_price: '83211.6', index_price: '83209.3', last_trade_price: 82782.2, daily_price_change: .5, daily_quote_token_volume: 2985511 }, { symbol: 'BAD', status: 'active', mark_price: 'NaN' }] })) as typeof fetch;
  const m = new LighterMarkets(request); await m.refresh();
  expect(m.state.testnet.markets).toHaveLength(1); expect(m.state.testnet.markets[0].id).toBe(4096); expect(m.state.mainnet.markets[0].mark).toBe(83211.6);
  await m.refresh(); expect(m.state.mainnet.markets[0].history).toHaveLength(2);
  const time = m.state.mainnet.updated; fail = true; await m.refresh(); expect(m.state.mainnet.status).toContain('stale'); expect(m.state.mainnet.updated).toBe(time);
  expect(m.state.mes.status).toContain('No CME');
});