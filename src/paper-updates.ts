/** Bounded, coalesced same-origin SSE snapshots. Slow clients must reconnect. */
export class PaperUpdates {
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private encoder = new TextEncoder();
  private sequence = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  constructor(private snapshot: () => unknown, private intervalMs = 250, private maxClients = 16) {
    // Also publishes stale/disconnected health and changes from other local tabs.
    this.heartbeat = setInterval(() => this.publish(), 1000);
    this.heartbeat.unref();
  }
  request() {
    if (this.pending || !this.clients.size) return;
    this.pending = setTimeout(() => { this.pending = null; this.publish(); }, this.intervalMs);
  }
  response(headers: Record<string, string>) {
    if (this.clients.size >= this.maxClients) return Response.json({ error: 'Paper update client limit reached' }, { status: 503, headers });
    let client: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        client = controller;
        this.clients.add(client);
        try { client.enqueue(this.frame()); }
        catch { this.clients.delete(client); client.error(new Error('Unable to publish paper account')); }
      },
      cancel: () => { this.clients.delete(client); },
    }, { highWaterMark: 2 });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  }
  private frame() { return this.encoder.encode(`id: ${++this.sequence}\nevent: paper\ndata: ${JSON.stringify(this.snapshot())}\n\n`); }
  private publish() {
    if (!this.clients.size) return;
    let frame: Uint8Array;
    try { frame = this.frame(); }
    catch { for (const client of this.clients) client.error(new Error('Unable to publish paper account')); this.clients.clear(); return; }
    for (const client of this.clients) {
      try {
        if ((client.desiredSize ?? 0) <= 0) { client.error(new Error('Slow paper update client')); this.clients.delete(client); }
        else client.enqueue(frame);
      } catch { this.clients.delete(client); }
    }
  }
  close() {
    clearInterval(this.heartbeat); if (this.pending) clearTimeout(this.pending); this.pending = null;
    for (const client of this.clients) { try { client.close(); } catch {} }
    this.clients.clear();
  }
}