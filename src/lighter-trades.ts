import type { BookClock, StreamMarket } from './lighter-book';
import { units } from './paper-math';

export type PublicTrade = {
  marketId: number; id: string; kind: string; priceTicks: string; quantityUnits: string;
  makerAsk: boolean; blockTimeMs: number; executionTimeUs: number | null; blockHeight: number; txHash: string;
};
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Public evidence only. A trade nonce is NOT documented as a contiguous book sequence. */
export function parseTrades(frame: any, market: StreamMarket, clock: BookClock, previousNonce?: number) {
  if (!['subscribed/trade', 'update/trade'].includes(frame?.type) || frame.channel !== `trade:${market.market_id}` ||
      !integer(frame.nonce) || !Array.isArray(frame.trades) || !Array.isArray(frame.liquidation_trades) ||
      frame.trades.length + frame.liquidation_trades.length > 1000) throw new Error('Invalid public trade envelope');
  if (previousNonce !== undefined && frame.nonce < previousNonce) throw new Error('Regressing trade nonce');
  const trades: PublicTrade[] = [], seen = new Map<string, string>();
  for (const t of [...frame.trades, ...frame.liquidation_trades]) {
    if (!t || t.market_id !== market.market_id || !integer(t.trade_id) ||
        (t.trade_id_str !== undefined && t.trade_id_str !== String(t.trade_id)) ||
        !['trade', 'liquidation', 'deleverage', 'market-settlement'].includes(t.type) || typeof t.is_maker_ask !== 'boolean' ||
        !integer(t.block_height) || !integer(t.timestamp) || t.timestamp < 1e12 || t.timestamp > clock.wall + 2000 ||
        !integer(t.transaction_time) || (t.transaction_time !== 0 && (t.transaction_time < 1e15 || t.transaction_time > (clock.wall + 2000) * 1000)) ||
        typeof t.tx_hash !== 'string' || !/^(?:0x)?[a-fA-F0-9]{32,128}$/.test(t.tx_hash)) throw new Error('Invalid public trade identity/timing');
    const decimal = (value: unknown, decimals: number) => {
      if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid public trade economics');
      const result = units(value, decimals);
      if (result <= 0n) throw new Error('Invalid public trade economics');
      return result.toString();
    };
    const trade: PublicTrade = { marketId: market.market_id, id: String(t.trade_id), kind: t.type,
      priceTicks: decimal(t.price, market.supported_price_decimals), quantityUnits: decimal(t.size, market.supported_size_decimals),
      makerAsk: t.is_maker_ask, blockTimeMs: t.timestamp, executionTimeUs: t.transaction_time || null, blockHeight: t.block_height, txHash: t.tx_hash.toLowerCase() };
    const payload = JSON.stringify(trade), old = seen.get(trade.id);
    if (old && old !== payload) throw new Error('Conflicting public trade ID');
    seen.set(trade.id, payload); trades.push(trade);
  }
  // The documented trade envelope has NO publication timestamp. Old block times
  // can be legitimate; local receive age is not proof of complete trade coverage.
  return { nonce: frame.nonce as number, trades };
}