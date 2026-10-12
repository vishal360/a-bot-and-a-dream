import { test, expect } from 'bun:test';
import { PaperUpdates } from '../src/paper-updates';

test('paper push sends initial and coalesced snapshots and cleans up canceled clients', async () => {
  let value = 1, calls = 0;
  const updates = new PaperUpdates(() => { calls++; return { value }; }, 10, 1);
  const response = updates.response({}), reader = response.body!.getReader(), decode = (v: Uint8Array | undefined) => new TextDecoder().decode(v);
  try {
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(decode((await reader.read()).value)).toContain('"value":1');
    expect(updates.response({}).status).toBe(503);
    value = 2; for (let n = 0; n < 50; n++) updates.request();
    expect(decode((await reader.read()).value)).toContain('"value":2'); expect(calls).toBe(2);
    await reader.cancel();
    const next = updates.response({}); expect(next.status).toBe(200); await next.body!.cancel();
  } finally { updates.close(); }
});

test('slow paper push clients are evicted instead of accumulating unbounded snapshots', async () => {
  const updates = new PaperUpdates(() => ({ ok: true }), 1, 1), response = updates.response({});
  try {
    updates.request(); await Bun.sleep(10); updates.request(); await Bun.sleep(10);
    await expect(response.body!.getReader().read()).rejects.toThrow('Slow');
    const next = updates.response({}); expect(next.status).toBe(200); await next.body!.cancel();
  } finally { updates.close(); }
});