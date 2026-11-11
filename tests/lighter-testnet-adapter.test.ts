import { describe, expect, test } from 'bun:test';
import { LighterTestnetAdapter, LIGHTER_TESTNET_ORIGIN, type LighterTestnetWasm, type TestnetAdapterOptions } from '../src/lighter-testnet-adapter';

const fakeKey = 'FAKE_TEST_KEY_NEVER_REAL';
const market = { market_id: 1, size_decimals: 4, price_decimals: 2 };
const order = () => ({ market, clientOrderIndex: 123, side: 'buy' as const, quantity: '0.0123', worstPrice: '3150.25', reduceOnly: false, nonce: 42, orderType: 'market' as const });
function fixture(reply: unknown = { code: 200, tx_hash: '0xfakehash' }) {
  const calls: { fn: string; args: unknown[] }[] = [], http: { url: string; init?: RequestInit }[] = [];
  const signer: LighterTestnetWasm = {
    CreateClient(...args) { calls.push({ fn: 'client', args }); return {}; },
    SignCreateOrder(...args) { calls.push({ fn: 'order', args }); return { txType: 14, txInfo: '{"signed":"fake"}' }; },
    SignCancelOrder(...args) { calls.push({ fn: 'cancel', args }); return { txType: 15, txInfo: '{"cancel":"fake"}' }; },
  };
  const options: TestnetAdapterOptions = { sessionOptIn: true, environment: 'testnet', chainId: 300, privateKey: fakeKey, keyIndex: 4, accountIndex: 77,
    signer, request: (async (url: RequestInfo | URL, init?: RequestInit) => { http.push({ url: String(url), init }); return new Response(JSON.stringify(reply)); }) as unknown as typeof fetch };
  return { calls, http, signer, options, adapter: () => new LighterTestnetAdapter(options) };
}

describe('isolated testnet WASM transport', () => {
  test('construction has explicit opt-in, fixed environment, and offline CreateClient contract', () => {
    const f = fixture(); expect(f.calls).toEqual([]); expect(f.http).toEqual([]);
    f.adapter(); expect(f.calls).toEqual([{ fn: 'client', args: ['', fakeKey, 300, 4, 77] }]); expect(f.http).toEqual([]);
    for (const bad of [{ sessionOptIn: false }, { environment: 'mainnet' }, { chainId: 304 }, { url: LIGHTER_TESTNET_ORIGIN }, { baseURL: 'https://mainnet.zklighter.elliot.ai' }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { keyIndex: 3 }]) {
      expect(() => new LighterTestnetAdapter({ ...f.options, ...bad } as any)).toThrow();
    }
  });
  test('market IOC uses exact integer units, explicit worstprice, nonce, expiry zero, all official positional fields', async () => {
    const f = fixture(), a = f.adapter();
    expect(await a.submitIoc(order())).toEqual({ status: 'accepted', txHash: '0xfakehash' });
    expect(f.calls[1]).toEqual({ fn: 'order', args: [1, 123, 123, 315025, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 4, 77] });
    const h = f.http[0]; expect(h.url).toBe(LIGHTER_TESTNET_ORIGIN + '/api/v1/sendTx');
    expect(h.init?.method).toBe('POST'); expect(h.init?.redirect).toBe('error'); expect(h.init?.credentials).toBe('omit');
    expect(h.init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(h.init?.body)).toBe('tx_type=14&tx_info=%7B%22signed%22%3A%22fake%22%7D');
    expect(JSON.stringify(f.http)).not.toContain(fakeKey);
  });
  test('sell reduce-only limit IOC and cancel preserve official arguments', async () => {
    const f = fixture(), a = f.adapter();
    await a.submitIoc({ ...order(), side: 'sell', reduceOnly: true, orderType: 'limit' });
    expect(f.calls[1].args.slice(4, 10)).toEqual([1, 0, 0, 1, 0, 0]);
    await a.cancelOrder(1, 9007199254740991, 43);
    expect(f.calls[2]).toEqual({ fn: 'cancel', args: [1, 9007199254740991, 0, 43, 4, 77] });
  });
  test('rejects invalid precision, float inputs, nonpositive values, and unsafe integers before signing or fetching', () => {
    const f = fixture(), a = f.adapter();
    for (const bad of [{ quantity: '0.00001' }, { quantity: '0.1' + '0'.repeat(30) + '1' }, { quantity: '0' }, { quantity: 0.1 }, { quantity: '1e-4' }, { worstPrice: '3150.251' }, { worstPrice: '-1' }, { worstPrice: '9007199254740992' }, { nonce: -1 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { clientOrderIndex: 2 ** 48 }, { reduceOnly: undefined }, { timeInForce: 1 }, { orderExpiry: 99 }, { triggerPrice: '1' }, { market: { ...market, size_decimals: 9 } }]) {
      expect(() => a.submitIoc({ ...order(), ...bad } as any)).toThrow();
    }
    expect(f.calls.length).toBe(1); expect(f.http.length).toBe(0);
  });
  test('acceptance requires code 200 and tx hash; venue refusal is not confirmed execution', async () => {
    for (const reply of [{ code: 200 }, { code: 200, tx_hash: '' }, { code: '200', tx_hash: 'fake' }, { code: 200, tx_hash: {} }]) {
      expect((await fixture(reply).adapter().submitIoc(order())).status).toBe('unknown');
    }
    expect(await fixture({ code: 21111, message: fakeKey }).adapter().submitIoc(order())).toEqual({ status: 'rejected', reason: 'Venue rejected transaction' });
  });
  test('transport errors and malformed responses are generic unknown, never retried', async () => {
    const f = fixture(); let count = 0;
    f.options.request = (async () => { count++; throw new Error(fakeKey); }) as unknown as typeof fetch;
    const result = await f.adapter().submitIoc(order());
    expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain(fakeKey); expect(count).toBe(1);
    for (const response of [new Response('oops'), new Response('{}', { status: 502 }), new Response('null')]) {
      const g = fixture(); g.options.request = (async () => response) as unknown as typeof fetch;
      expect((await g.adapter().submitIoc(order())).status).toBe('unknown');
    }
  });
  test('signer and initialization errors never expose keys, and signing failures do not send', async () => {
    const f = fixture(); f.signer.CreateClient = () => { throw new Error(fakeKey); };
    expect(() => f.adapter()).toThrow('Testnet signer initialization failed');
    const g = fixture(); g.signer.SignCreateOrder = () => ({ error: fakeKey });
    await expect(g.adapter().submitIoc(order())).rejects.toThrow('Testnet transaction signing failed'); expect(g.http).toEqual([]);
    const h = fixture(); h.signer.SignCancelOrder = () => { throw new Error(fakeKey); };
    await expect(h.adapter().cancelOrder(1, 2, 3)).rejects.toThrow('Testnet transaction signing failed'); expect(h.http).toEqual([]);
  });
  test('nonce read has fixed endpoint and validates safe numeric/string nonce', async () => {
    for (const nonce of [0, 123, '123', Number.MAX_SAFE_INTEGER]) {
      const f = fixture({ code: 200, nonce }); expect(await f.adapter().nextNonce()).toBe(Number(nonce));
      expect(f.http[0].url).toBe(LIGHTER_TESTNET_ORIGIN + '/api/v1/nextNonce?account_index=77&api_key_index=4');
    }
    for (const nonce of [-1, 1.2, '1e2', '9007199254740992', null, {}, undefined]) {
      await expect(fixture({ code: 200, nonce }).adapter().nextNonce()).rejects.toThrow('Testnet nonce unavailable');
    }
  });
  test('metadata reader validates actual signing decimals, never substitutes supported display precision', async () => {
    const f = fixture({ code: 200, order_book_details: [{ ...market, supported_size_decimals: 1, supported_price_decimals: 1 }] });
    expect(await f.adapter().readMarketMetadata(1)).toEqual(market);
    for (const rows of [[], [market, market], [{ market_id: 1, supported_size_decimals: 4, supported_price_decimals: 2 }], [{ ...market, price_decimals: '2' }]]) {
      await expect(fixture({ code: 200, order_book_details: rows }).adapter().readMarketMetadata(1)).rejects.toThrow('Testnet market metadata unavailable');
    }
  });
  test('stream response budget rejects over 2 MiB before concat and cancels reader', async () => {
    const f = fixture(); let canceled = false, reads = 0;
    f.options.request = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { canceled = true; },
    }))) as unknown as typeof fetch;
    expect((await f.adapter().submitIoc(order())).status).toBe('unknown');
    expect(canceled).toBe(true); expect(reads).toBeLessThanOrEqual(4);
    const g = fixture(); let bodyCanceled = false; g.options.timeoutMs = 100;
    g.options.request = (async () => new Response(new ReadableStream<Uint8Array>({ cancel() { bodyCanceled = true; } }))) as unknown as typeof fetch;
    expect((await g.adapter().submitIoc(order())).status).toBe('unknown'); expect(bodyCanceled).toBe(true);
  });
  test('bounded timeout returns unknown without retry even when injected fetch ignores abort', async () => {
    const f = fixture(); let count = 0; f.options.timeoutMs = 100;
    f.options.request = (() => { count++; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
    expect((await f.adapter().submitIoc(order())).status).toBe('unknown'); expect(count).toBe(1);
  });
  test('per-dispatch lease fence runs immediately before signing and fetch for create and cancel', async () => {
    for (const cancel of [false, true]) {
      const f = fixture(), a = f.adapter(), events: string[] = [];
      const original = cancel ? f.signer.SignCancelOrder : f.signer.SignCreateOrder;
      const wrap = (...args: any[]) => { events.push('sign'); return (original as any)(...args); };
      if (cancel) f.signer.SignCancelOrder = wrap; else f.signer.SignCreateOrder = wrap;
      let checks = 0;
      const fence = () => { events.push('fence'); checks++; };
      const result = cancel ? await a.cancelOrder(1, 2, 3, fence) : await a.submitIoc(order(), fence);
      expect(result.status).toBe('accepted'); expect(checks).toBe(2); expect(events).toEqual(['fence', 'sign', 'fence']); expect(f.http.length).toBe(1);
    }
  });
  test('lease revoked before signing or during signing never dispatches or exposes fence error', async () => {
    const f = fixture(), a = f.adapter();
    await expect(a.submitIoc(order(), () => { throw new Error(fakeKey); })).rejects.toThrow('Testnet transaction signing failed');
    expect(f.calls.length).toBe(1); expect(f.http).toEqual([]);
    for (const cancel of [false, true]) {
      const g = fixture(); let current = true;
      const sign = () => { current = false; return { txType: 14, txInfo: 'fake' }; };
      if (cancel) g.signer.SignCancelOrder = sign; else g.signer.SignCreateOrder = sign;
      const b = g.adapter(), fence = () => { if (!current) throw new Error(fakeKey); };
      const result = cancel ? await b.cancelOrder(1, 2, 3, fence) : await b.submitIoc(order(), fence);
      expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain(fakeKey); expect(g.http).toEqual([]);
    }
  });
  test('overlapping submissions are blocked, without an automatic nonce allocator', async () => {
    const f = fixture(); let release!: (r: Response) => void;
    f.options.request = (() => new Promise<Response>(resolve => { release = resolve; })) as unknown as typeof fetch;
    const a = f.adapter(), pending = a.submitIoc(order());
    await expect(a.cancelOrder(1, 2, 43)).rejects.toThrow('Concurrent testnet submission forbidden');
    release(new Response('{"code":200,"tx_hash":"fake"}')); await pending;
    expect(f.calls.length).toBe(2);
  });
});
