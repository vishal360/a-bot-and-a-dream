// Loaded only by isolated test child processes. Production has no fixture switch.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: any, init?: any) => {
  const url = String(input);
  if (!['mainnet.zklighter.elliot.ai', 'testnet.zklighter.elliot.ai'].includes(new URL(url).hostname)) throw new Error(`Unexpected outbound test request: ${url}`);
  if (url.includes('/orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '0.00001', min_quote_amount: '10', last_trade_price: '50000' }] });
  if (url.includes('/orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '50000', remaining_base_amount: '1' }], asks: [{ price: '50010', remaining_base_amount: '0.001' }, { price: '50020', remaining_base_amount: '0.001' }] });
  return Response.json({ code: 200, order_books: [] });
}, { preconnect: originalFetch.preconnect }) as typeof fetch;
export {};