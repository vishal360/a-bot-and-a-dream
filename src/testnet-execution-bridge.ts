import { LighterTestnetAdapter, type TestnetAdapterOptions, type TestnetMarket } from './lighter-testnet-adapter';
import type { AccountBinding, VenueSigningAdapter } from './execution-coordinator';

function decimal(integer: number, places: number) {
  if (!Number.isSafeInteger(integer) || integer <= 0 || !Number.isInteger(places) || places < 0 || places > 8) throw new Error('Invalid scaled execution integer');
  const text = String(integer).padStart(places + 1, '0');
  return places ? `${text.slice(0, -places)}.${text.slice(-places)}` : text;
}
/** Optional bridge only; never imported by server and never reads credentials.
 * OMS quantity uses base atoms, price uses venue price atoms. Its money/risk limits
 * must ALL use their integer PRODUCT units, not USD/micros. No leverage normalization
 * is invented. A production scale-normalized risk layer is still required.
 */
export function createLighterTestnetBridge(binding: AccountBinding, options: TestnetAdapterOptions,
  markets: Readonly<Record<string, TestnetMarket>>): VenueSigningAdapter {
  if (binding.environment !== 'testnet' || binding.chainId !== '300'
    || binding.accountId !== String(options.accountIndex) || binding.apiKeyId !== String(options.keyIndex)) throw new Error('Testnet bridge account/key/chain binding mismatch');
  binding = Object.freeze({ ...binding });
  const metadata = Object.fromEntries(Object.entries(markets).map(([symbol, m]) => {
    if (!/^[A-Z0-9-]{1,32}$/.test(symbol) || !Number.isSafeInteger(m.market_id) || m.market_id < 0
      || !Number.isInteger(m.size_decimals) || m.size_decimals < 0 || m.size_decimals > 8
      || !Number.isInteger(m.price_decimals) || m.price_decimals < 0 || m.price_decimals > 8) throw new Error('Invalid bridge market signing metadata');
    return [symbol, Object.freeze({ ...m })];
  }));
  const moneyScales = new Set(Object.values(metadata).map(m => m.size_decimals + m.price_decimals));
  if (moneyScales.size > 1) throw new Error('Mixed market product scales require reviewed normalization; bridge refused');
  const transport = new LighterTestnetAdapter(options);
  return {
    async send(request) {
      const { order, nonce, assertCurrentLease } = request;
      for (const key of ['environment', 'chainId', 'accountId', 'apiKeyId', 'generation'] as const)
        if (order.binding[key] !== binding[key]) throw new Error('Order bridge binding mismatch');
      const market = metadata[order.symbol];
      if (!market || nonce > 2 ** 48 - 1) throw new Error('Unknown market or client index overflow');
      assertCurrentLease();
      const response = await transport.submitIoc({ market, clientOrderIndex: nonce, nonce,
        quantity: decimal(order.quantity, market.size_decimals), worstPrice: decimal(order.worstPrice, market.price_decimals),
        side: order.side, reduceOnly: order.reduceOnly, orderType: 'limit' }, assertCurrentLease);
      if (response.status !== 'accepted') throw new Error('Testnet acceptance unresolved; coordinator must retain reservation');
      // Transaction acceptance is not an exchange order ID or a fill.
      return { accepted: true, transactionId: response.txHash };
    }
  };
}
