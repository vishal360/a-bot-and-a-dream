/** Decimal input -> exact integer units. Never rounds invalid venue precision. */
export function units(value: number | string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('Invalid precision');
  let text = String(value);
  if (text.startsWith('.')) text = '0' + text;
  if (/^\d+(?:\.\d+)?e-\d+$/.test(text)) {
    const [coefficient, exponent] = text.split('e-'), [whole, fraction = ''] = coefficient.split('.');
    const point = whole.length - Number(exponent), digits = whole + fraction;
    text = point <= 0 ? '0.' + '0'.repeat(-point) + digits : digits.slice(0, point) + '.' + digits.slice(point);
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Invalid decimal economics');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.slice(decimals).replace(/0/g, '')) throw new Error('Quantity/price violates precision');
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals).padEnd(decimals, '0')) || '0');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Economics overflow');
  return result;
}
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
export function matchIOC(side: 'buy' | 'sell', quantity: number, levels: { price: number; quantity: number }[], sizeDecimals: number, priceDecimals: number, feeBps: number) {
  let remaining = units(quantity, sizeDecimals), filled = 0n, numerator = 0n;
  const best = units(levels[0].price, priceDecimals), executions: { price: number; quantity: number }[] = [];
  if (best <= 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) throw new Error('Invalid matching economics');
  for (const level of levels) {
    const price = units(level.price, priceDecimals), available = units(level.quantity, sizeDecimals);
    if (price <= 0n || available <= 0n) throw new Error('Invalid depth economics');
    const distance = price > best ? price - best : best - price;
    if (distance * 10000n > best * 50n) break;
    const q = remaining < available ? remaining : available;
    numerator += q * price; filled += q; remaining -= q;
    executions.push({ price: level.price, quantity: Number(q) / 10 ** sizeDecimals });
    if (remaining === 0n) break;
  }
  if (filled === 0n) throw new Error('No executable depth');
  const denominator = 10n ** BigInt(sizeDecimals + priceDecimals);
  // Conservative settlement: buys round up, proceeds round down, fees round up.
  const micros = side === 'buy' ? ceil(numerator * 1000000n, denominator) : numerator * 1000000n / denominator;
  const feeMicros = ceil(numerator * 1000000n * BigInt(feeBps), denominator * 10000n);
  if (micros + feeMicros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Settlement overflow');
  return { filled: Number(filled) / 10 ** sizeDecimals, canceled: Number(remaining) / 10 ** sizeDecimals,
    price: Number(numerator) / Number(filled) / 10 ** priceDecimals,
    cost: Number(micros) / 1000000, fee: Number(feeMicros) / 1000000,
    quoteMicros: micros.toString(), feeMicros: feeMicros.toString(), executions };
}