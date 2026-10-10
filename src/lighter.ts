export const lighterHosts = { mainnet: 'https://mainnet.zklighter.elliot.ai', testnet: 'https://testnet.zklighter.elliot.ai' };
export class LighterMarkets {
  state: any = { mainnet: { markets: [], status: 'connecting', updated: null }, testnet: { markets: [], status: 'connecting', updated: null }, mes: { status: 'No CME futures feed connected' } };
  private busy = false;
  constructor(private request: typeof fetch = fetch) {}
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try { await Promise.all(Object.entries(lighterHosts).map(async ([network, host]) => {
      try {
        const response = await this.request(host + '/api/v1/orderBookDetails', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Venue unavailable');
        const body = await response.json();
        if (body.code !== 200 || !Array.isArray(body.order_book_details)) throw new Error('Invalid venue response');
        const previous = this.state[network];
        const markets = body.order_book_details.filter((m: any) => m.status === 'active').map((m: any) => {
          const mark = Number(m.mark_price), index = Number(m.index_price), last = Number(m.last_trade_price);
          if (!Number.isFinite(mark) || mark <= 0) return null;
          return { symbol: m.symbol, id: m.market_id, mark, index: Number.isFinite(index) && index > 0 ? index : null, last: Number.isFinite(last) && last > 0 ? last : null, change: Number(m.daily_price_change), volume: Number(m.daily_quote_token_volume), history: [...(previous.markets.find((p: any) => p.id === m.market_id)?.history || []), mark].slice(-240) };
        }).filter(Boolean).sort((a: any, b: any) => b.volume - a.volume);
        this.state[network] = { markets, status: 'connected', updated: new Date().toISOString() };
      } catch { this.state[network] = { ...this.state[network], status: 'disconnected / quotes may be stale' }; }
    })); } finally { this.busy = false; }
  }
}