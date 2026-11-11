import { units } from './paper-math';

export const LIGHTER_TESTNET_ORIGIN = 'https://testnet.zklighter.elliot.ai';
export const LIGHTER_TESTNET_CHAIN_ID = 300;

/** The official Go/WASM exports, injected by the owner; this module loads no binary. */
export interface LighterTestnetWasm {
  CreateClient(url: string, privateKey: string, chainId: number, keyIndex: number, accountIndex: number): unknown;
  SignCreateOrder(marketId: number, clientOrderIndex: number, baseSizeInt: number, priceInt: number,
    isAsk: number, orderType: number, timeInForce: number, reduceOnly: number, triggerPrice: number,
    orderExpiry: number, integratorAccount: number, integratorTakerFee: number, integratorMakerFee: number,
    selfTradeBehavior: number, selfTradeEquality: number, skipNonce: number, nonce: number,
    keyIndex: number, accountIndex: number): unknown;
  SignCancelOrder(marketId: number, orderIndex: number, skipNonce: number, nonce: number, keyIndex: number, accountIndex: number): unknown;
}
export type TestnetMarket = Readonly<{ market_id: number; size_decimals: number; price_decimals: number }>;
export type TestnetIocOrder = {
  market: TestnetMarket; clientOrderIndex: number; side: 'buy' | 'sell';
  quantity: string; worstPrice: string; reduceOnly: boolean; nonce: number;
  orderType: 'market' | 'limit';
};
export type TestnetSubmission =
  | { status: 'accepted'; txHash: string }
  | { status: 'rejected'; reason: 'Venue rejected transaction' }
  | { status: 'unknown'; reason: 'Transaction outcome unknown; reconcile before any further action' };
export type TestnetAdapterOptions = {
  sessionOptIn: true; environment: 'testnet'; chainId: 300;
  privateKey: string; keyIndex: number; accountIndex: number;
  signer: LighterTestnetWasm; request: typeof fetch; timeoutMs?: number;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
function requireInteger(v: unknown, max?: number): asserts v is number {
  if (!integer(v, max)) throw new Error('Invalid nonnegative safe integer');
}
function validateMarket(m: TestnetMarket) {
  if (!record(m) || !integer(m.market_id) || !integer(m.size_decimals, 8) || !integer(m.price_decimals, 8)) throw new Error('Invalid market signing metadata');
}
function scaled(value: string, decimals: number) {
  // Only explicit decimal strings enter the signing boundary. Never round floats or exponent notation.
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Explicit decimal string required');
  const n = units(value, decimals);
  if (n <= 0n) throw new Error('Positive quantity and worst price required');
  return Number(n); // units rejects anything above MAX_SAFE_INTEGER.
}
function checked(v: unknown) {
  if (!record(v) || (v.error !== undefined && v.error !== null && v.error !== '')) throw new Error('Signer failed');
  return v;
}

/** Isolated opt-in transport. No routes, environment reads, key persistence, retries, or confirmation claims. */
export class LighterTestnetAdapter {
  #signer: LighterTestnetWasm;
  #request: typeof fetch;
  #keyIndex: number;
  #accountIndex: number;
  #timeoutMs: number;
  #busy = false;
  constructor(options: TestnetAdapterOptions) {
    if (!options || options.sessionOptIn !== true || options.environment !== 'testnet' || options.chainId !== 300) throw new Error('Explicit chain 300 testnet session opt-in required');
    // Reject runtime URL/config overrides as well as typed misuse; there is exactly one transport origin.
    if (['url', 'baseUrl', 'baseURL', 'host', 'origin'].some(k => k in options)) throw new Error('Testnet URL overrides are forbidden');
    requireInteger(options.accountIndex); requireInteger(options.keyIndex, 254);
    if (options.keyIndex < 4 || typeof options.privateKey !== 'string' || !options.privateKey || options.privateKey.length > 4096) throw new Error('Invalid signer credentials');
    const timeout = options.timeoutMs ?? 10000;
    if (!integer(timeout, 30000) || timeout < 100) throw new Error('Timeout must be 100..30000 ms');
    if (!options.signer || ['CreateClient', 'SignCreateOrder', 'SignCancelOrder'].some(k => typeof (options.signer as any)[k] !== 'function') || typeof options.request !== 'function') throw new Error('Injected signer and fetch required');
    this.#signer = options.signer; this.#request = options.request;
    this.#keyIndex = options.keyIndex; this.#accountIndex = options.accountIndex; this.#timeoutMs = timeout;
    try { checked(this.#signer.CreateClient('', options.privateKey, 300, this.#keyIndex, this.#accountIndex)); }
    catch { throw new Error('Testnet signer initialization failed'); }
  }
  async #json(path: string, init: RequestInit = {}, assertCurrentLease?: () => void): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race also bounds an incorrectly implemented injected fetch which ignores AbortSignal.
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')); }, this.#timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        assertCurrentLease?.(); // Last synchronous fence before handing the write to fetch.
        const response = await this.#request(LIGHTER_TESTNET_ORIGIN + path, { ...init, redirect: 'error', signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('Request failed');
        if (!response.body) throw new Error('Missing response body');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        const limit = 2 * 1024 * 1024;
        let bytes = 0, complete = false;
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          if (controller.signal.aborted) throw new Error('Request timed out');
          for (;;) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw new Error('Request timed out');
            if (chunk.done) { complete = true; break; }
            if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > limit - bytes) throw new Error('Response too large');
            bytes += chunk.value.byteLength;
            chunks.push(chunk.value);
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          if (!complete) cancel();
          reader.releaseLock();
        }
        // Allocate/concatenate only after every chunk has passed the byte budget.
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        if (!record(body)) throw new Error('Invalid response');
        return body;
      })()]);
    } finally { clearTimeout(timer); }
  }
  /** Read only. Caller must serialize nonce allocation across every owner of this API key. */
  async nextNonce(): Promise<number> {
    try {
      const body = await this.#json(`/api/v1/nextNonce?account_index=${this.#accountIndex}&api_key_index=${this.#keyIndex}`);
      if (body.code !== 200) throw new Error('Invalid nonce response');
      let nonce = body.nonce;
      if (typeof nonce === 'string' && /^\d{1,16}$/.test(nonce)) nonce = Number(nonce);
      requireInteger(nonce);
      return nonce;
    } catch { throw new Error('Testnet nonce unavailable'); }
  }
  /** Validates the official signing decimals, not display/supported decimals. */
  async readMarketMetadata(marketId: number): Promise<TestnetMarket> {
    requireInteger(marketId);
    try {
      const body = await this.#json('/api/v1/orderBookDetails');
      if (body.code !== 200 || !Array.isArray(body.order_book_details) || body.order_book_details.length > 10000) throw new Error('Invalid markets');
      const rows = body.order_book_details.filter((m: unknown) => record(m) && m.market_id === marketId);
      if (rows.length !== 1) throw new Error('Market missing or duplicate');
      const row = rows[0] as TestnetMarket; validateMarket(row);
      return Object.freeze({ market_id: row.market_id, size_decimals: row.size_decimals, price_decimals: row.price_decimals });
    } catch { throw new Error('Testnet market metadata unavailable'); }
  }
  async #submit(sign: () => unknown, assertCurrentLease?: () => void): Promise<TestnetSubmission> {
    if (this.#busy) throw new Error('Concurrent testnet submission forbidden');
    this.#busy = true;
    try {
      let tx: Record<string, unknown>;
      try {
        assertCurrentLease?.();
        tx = checked(sign());
        if (!integer(tx.txType) || typeof tx.txInfo !== 'string' || !tx.txInfo || tx.txInfo.length > 100000) throw new Error('Invalid signed transaction');
      } catch { throw new Error('Testnet transaction signing failed'); }
      try {
        const body = await this.#json('/api/v1/sendTx', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ tx_type: String(tx.txType), tx_info: tx.txInfo as string }) }, assertCurrentLease);
        if (integer(body.code) && body.code !== 200) return { status: 'rejected', reason: 'Venue rejected transaction' };
        if (body.code !== 200 || typeof body.tx_hash !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.tx_hash)) throw new Error('Missing transaction identity');
        return { status: 'accepted', txHash: body.tx_hash };
      } catch { return { status: 'unknown', reason: 'Transaction outcome unknown; reconcile before any further action' }; }
    } finally { this.#busy = false; }
  }
  submitIoc(order: TestnetIocOrder, assertCurrentLease?: () => void): Promise<TestnetSubmission> {
    validateMarket(order.market); requireInteger(order.clientOrderIndex, 2 ** 48 - 1); requireInteger(order.nonce);
    if (!['buy', 'sell'].includes(order.side) || typeof order.reduceOnly !== 'boolean' || !['market', 'limit'].includes(order.orderType)) throw new Error('Invalid IOC order');
    if (['triggerPrice', 'orderExpiry', 'timeInForce'].some(k => k in order)) throw new Error('IOC lifecycle overrides forbidden');
    const quantity = scaled(order.quantity, order.market.size_decimals), price = scaled(order.worstPrice, order.market.price_decimals);
    return this.#submit(() => this.#signer.SignCreateOrder(order.market.market_id, order.clientOrderIndex, quantity, price,
      order.side === 'sell' ? 1 : 0, order.orderType === 'market' ? 1 : 0, 0, order.reduceOnly ? 1 : 0, 0, 0,
      0, 0, 0, 0, 0, 0, order.nonce, this.#keyIndex, this.#accountIndex), assertCurrentLease);
  }
  cancelOrder(marketId: number, orderIndex: number, nonce: number, assertCurrentLease?: () => void): Promise<TestnetSubmission> {
    requireInteger(marketId); requireInteger(orderIndex); requireInteger(nonce);
    return this.#submit(() => this.#signer.SignCancelOrder(marketId, orderIndex, 0, nonce, this.#keyIndex, this.#accountIndex), assertCurrentLease);
  }
}
