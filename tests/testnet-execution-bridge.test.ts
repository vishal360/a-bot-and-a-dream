import { test, expect } from 'bun:test';
import { createLighterTestnetBridge } from '../src/testnet-execution-bridge';
import type { TestnetAdapterOptions } from '../src/lighter-testnet-adapter';
const binding = { environment: 'testnet' as const, chainId: '300', accountId: '7', apiKeyId: '4', generation: 'fixture' };
function harness() {
  const calls: any[] = [], requests: any[] = [];
  const options: TestnetAdapterOptions = { sessionOptIn: true, environment: 'testnet', chainId: 300,
    accountIndex: 7, keyIndex: 4, privateKey: 'fake-key', signer: {
      CreateClient: () => ({}), SignCreateOrder: (...args) => { calls.push(args); return { txType: 14, txInfo: 'fixture-only' }; }, SignCancelOrder: () => ({})
    }, request: (async (url: any, init: any) => { requests.push({ url, init }); return new Response(JSON.stringify({ code: 200, tx_hash: 'fixture-hash' })); }) as typeof fetch };
  return { options, calls, requests };
}
test('bridge binds testnet account/key/chain and converts scaled integers exactly into IOC signer fields', async () => {
  const h = harness(); let checks = 0;
  const bridge = createLighterTestnetBridge(binding, h.options, { BTC: { market_id: 1, size_decimals: 4, price_decimals: 2 } });
  const result = await bridge.send({ order: { binding, symbol: 'BTC', quantity: 1234, worstPrice: 5000123, side: 'buy', reduceOnly: false } as any,
    nonce: 9, fence: 1, leaseOwner: 'fixture', assertCurrentLease: () => { checks++; } });
  expect(result).toEqual({ accepted: true, transactionId: 'fixture-hash' });
  expect(h.calls[0].slice(0, 10)).toEqual([1, 9, 1234, 5000123, 0, 0, 0, 0, 0, 0]);
  expect(checks).toBeGreaterThanOrEqual(3);
  expect(h.requests[0].url).toBe('https://testnet.zklighter.elliot.ai/api/v1/sendTx');
});
test('bridge rejects mainnet, account mismatch and stale lease without dispatch', async () => {
  const h = harness();
  expect(() => createLighterTestnetBridge({ ...binding, chainId: '304' }, h.options, {})).toThrow('binding');
  expect(() => createLighterTestnetBridge(binding, h.options, {
    BTC: { market_id: 1, size_decimals: 4, price_decimals: 2 }, ETH: { market_id: 2, size_decimals: 2, price_decimals: 2 }
  })).toThrow('Mixed market product scales');
  const bridge = createLighterTestnetBridge(binding, h.options, { BTC: { market_id: 1, size_decimals: 4, price_decimals: 2 } });
  await expect(bridge.send({ order: { binding, symbol: 'BTC', quantity: 1, worstPrice: 1 } as any, nonce: 1, fence: 1, leaseOwner: 'fixture', assertCurrentLease: () => { throw new Error('lost fence'); } })).rejects.toThrow('lost fence');
  expect(h.requests).toHaveLength(0); expect(h.calls).toHaveLength(0);
});
