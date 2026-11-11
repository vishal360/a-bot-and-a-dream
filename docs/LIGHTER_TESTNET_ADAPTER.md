# Stage 4: isolated, opt-in Lighter testnet adapter

## Status and scope

This is an independent transport building block, **not an enabled trading integration**. Nothing imports it into the server or registers a route. Importing the module has no signer, filesystem, environment-variable, or network side effects. Construction requires explicit `sessionOptIn: true`, `environment: 'testnet'`, and `chainId: 300` and initializes only an injected signer. Every HTTP request is pinned to `https://testnet.zklighter.elliot.ai`; URL overrides and mainnet configuration are rejected.

**Actual official WASM binaries and matching Go JavaScript glue are not bundled or loaded yet. No real signing, key registration, network request, or testnet execution was performed to validate this implementation.** Tests use fake keys, fake signer functions, and fake fetch exclusively. Do not describe this stage as testnet-verified or production-ready.

## Official contract used

References:

- [Official TypeScript/WASM quickstart](https://docs.lighter.xyz/developers/getting-started/quickstart-typescript.md)
- [Official transaction signing guide](https://docs.lighter.xyz/developers/integration-guides/signing-transactions.md)

The injected `LighterTestnetWasm` interface mirrors the documented positional exports:

```text
CreateClient('', privateKey, 300, keyIndex, accountIndex)
SignCreateOrder(marketId, clientOrderIndex, baseSizeInt, priceInt,
  isAsk, orderType, timeInForce, reduceOnly, triggerPrice, orderExpiry,
  integratorAccount, integratorTakerFee, integratorMakerFee,
  selfTradeBehavior, selfTradeEquality, skipNonce, nonce, keyIndex, accountIndex)
SignCancelOrder(marketId, orderIndex, 0, nonce, keyIndex, accountIndex)
```

`CreateClient` is called with an **empty URL**, never an HTTP origin. No `CheckClient`, implicit nonce `-1`, or other signer-side HTTP operation is exposed. The caller must inject the actual official exports after independently verifying and loading their matching WASM/glue build. The interface does not implement cryptography itself.

## Order boundary

`submitIoc` supports only explicit market or limit **IOC** orders. It always signs `timeInForce=0`, `orderExpiry=0`, `triggerPrice=0`, zero integrator fields, zero self-trade fields, and `skipNonce=0`. Runtime attempts to override lifecycle fields are rejected. A required positive `worstPrice` bounds execution: buys pay no more and sells receive no less than that limit, according to venue IOC semantics. An explicit boolean `reduceOnly` is mandatory and transmitted as `0`/`1`; it is not inferred from local position guesses. This adapter does not independently validate a position or guarantee venue enforcement.

Quantity and worst price must be unsigned ordinary decimal **strings**. They pass through the existing exact `units` conversion using validated `size_decimals` and `price_decimals`, each an integer from 0 through 8. There is no `Math.round`, implicit float quantity, exponent-string conversion, precision truncation, or unsafe integer conversion. Positive integer results must fit JavaScript's safe integer range before crossing the documented WASM number interface. Client order IDs must fit uint48; uniqueness across markets is the coordinator's responsibility. Cancel order IDs and nonces must be nonnegative safe integers.

The optional `readMarketMetadata(marketId)` read uses the fixed `/api/v1/orderBookDetails` endpoint and validates one unique matching market and its actual signing decimals. It deliberately does **not** substitute `supported_size_decimals` / `supported_price_decimals`, which can describe display precision. Alternatively the coordinator may inject already-validated explicit signing metadata; its provenance/freshness remains the coordinator's responsibility.

## Nonces, transport, and result semantics

`nextNonce()` reads only the fixed `/api/v1/nextNonce?account_index=...&api_key_index=...` endpoint and requires a successful venue envelope plus a safe nonnegative numeric or decimal-string nonce. There is no automatic nonce fetch, increment, or retry during a write. The coordinator supplies every nonce and must serialize all users of the key, reconcile unresolved outcomes, and ensure durable idempotency. One adapter instance rejects overlapping writes, but cannot coordinate separate instances, processes, or other clients of the same signer/key. Official WASM client state is owned by the injected runtime; avoid reinitializing that shared state for the same account/key underneath an adapter.

`submitIoc(order, assertCurrentLease?)` and `cancelOrder(marketId, orderIndex, nonce, assertCurrentLease?)` accept a synchronous **per-dispatch** lease fence. The coordinator must supply its current request's bound `assertCurrentLease` callback on integrated sends. It runs immediately before signing and again immediately before calling fetch for `sendTx`, with no intervening await. A pre-sign fence failure throws the generic signing error without signing or dispatching. If signing advances time or otherwise revokes the lease, the second fence prevents dispatch and returns generic `unknown`, never `rejected`; fence exception text is not exposed. The optional callback exists only for standalone opt-in testnet usage, not as a replacement for coordinator lease enforcement. No callback can revoke a transaction already passed to fetch.

Writes are form-encoded `POST /api/v1/sendTx` with `tx_type` and `tx_info`. Redirects are errors, credentials are omitted, and referrers are suppressed. Timeout defaults to 10 seconds and must be within 100–30,000 ms; an abort signal and deadline race bound waiting even if the injected fetch ignores cancellation. Response bodies are read as a bounded stream: accumulated chunks may total at most 2 MiB before concatenation/UTF-8 decoding/JSON parsing. Oversized or timed-out streams are canceled; no unbounded `.text()` allocation is used. The fetch implementation still controls the size of any individual chunk it allocates.

Results are deliberately narrow:

- `accepted` requires HTTP success, numeric venue `code: 200`, and a nonempty bounded transaction hash; it returns `txHash` only. **Accepted does not mean sequenced, executed, filled, confirmed, or reconciled.**
- `rejected` requires an HTTP-successful parsed response with an explicit numeric non-200 venue code; only a generic reason is returned.
- `unknown` covers transport failures, timeout, HTTP failure, malformed responses, or missing transaction identity. A submission might already have reached the sequencer. **Do not automatically retry or reuse its nonce.** Reconcile externally before further action.

Validation and signer failures throw fixed local errors before any HTTP submission. Signer exception messages, venue messages, private keys, and signed payloads are never logged or attached as error causes. A raw key is passed once to injected `CreateClient` and is not retained by the adapter as a field. The caller and official WASM runtime still own their credential memory: this is not secure memory erasure, a vault, or protection against a malicious injected signer/fetch.

## Deliberate exclusions and integration obligations

There is no default signer, key file, environment-key loader, bundled binary, server route, automatic import into runtime, mainnet transport, automatic retry, auth-token handling, authenticated order/account lookup, guessed account snapshot schema, or account reconciliation/confirmation state. There is no native-stop method in this stage; do not route stops through IOC or claim protective-stop coverage. No transaction lookup method or execution-confirmation shortcut is provided.

The parent coordinator can integrate this independent interface later, behind its own explicit session authorization, risk gates, durable intent/nonce/transaction identities, cancellation policy, and authoritative account/order/transaction reconciliation. Authenticated reads must not be added without the official `CreateAuthToken` contract and validators. Actual execution confirmation needs a separately verified official event/read contract; `sendTx` acceptance alone is never sufficient.

## Local checks

With Bun on `PATH`:

```powershell
bun test tests/lighter-testnet-adapter.test.ts
bun run typecheck
```

The tests exercise official positional arguments, offline initialization, fixed testnet URL, opt-in rejection, IOC expiry zero, reduce-only mapping, exact decimal precision/overflow rejection, safe nonce reads, metadata validation, generic failures, missing hashes, bounded timeout, no retry, and overlapping-write refusal. They do not use actual keys or external HTTP.
