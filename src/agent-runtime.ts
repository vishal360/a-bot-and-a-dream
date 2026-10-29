import type { Store } from './store';
import type { DecisionJournal } from './journal';
import { buildProposal, validateProposalFields, validateStoredProposal, type AgentProposal } from './agent-contract';
import { ensembleDirection } from './agent-ensemble';

export type AgentMarketContext = {
  symbol: string; mark: number; fundingRate: number | null; equity: number | null; time: string;
};
export type AgentContextProvider = () => AgentMarketContext[];
export type AgentPersona = { agentId: string; model: string; persona: string };

/** The locked agent roster: three independent proposal sources for the 2-of-3 ensemble.
 *  Deliberately cheap models on the free tier; the personas disagree by construction. */
export const DEFAULT_AGENTS: AgentPersona[] = [
  { agentId: 'agent-gemini-momentum', model: 'gemini-3.8-flash', persona: 'You are a short-horizon momentum analyst for crypto perpetuals. You favor continuation of the recent move when the data supports it.' },
  { agentId: 'agent-gemini-skeptic', model: 'gemini-3.5-flash-lite', persona: 'You are a conservative risk analyst. You distrust continuation, look for exhaustion, and prefer flat unless the evidence is strong.' },
  { agentId: 'agent-gemini-flow', model: 'gemini-3.5-flash-lite', persona: 'You are a market-microstructure analyst focused on funding, mark vs index relationships and short-term flow.' },
];
// Model roster current as of 2026-10-30: Google deprecated gemini-2.5-* for new keys
// (HTTP 404 "no longer available to new users"); 3.8-flash occasionally 503s under load
// (the runtime retries), 3.5-flash-lite serves reliably.

export type PendingShadow = {
  id: string; agentId: string; symbol: string; direction: 'long' | 'short'; confidence: number;
  markAt: number; rationale: string; createdAt: string; expiresAtMs: number;
};

export type AgentRuntimeOptions = {
  agents?: AgentPersona[];
  intervalMs?: number;
  dailyRequestCap?: number;
  requestTimeoutMs?: number;
  maxMarketsPerTick?: number;
  now?: () => number;
};

/** The agent runtime (docs/AGENT_SETUP.md, build order steps 2-3): calls the configured
 *  Gemini models for proposals, builds expiring contracts, applies the 2-of-3 ensemble,
 *  journals everything (journal-as-agent-memory) and runs SHADOW MODE: proposals are
 *  recorded and graded at expiry against the real mark, but NOTHING is ever executed.
 *
 *  Fail-closed properties: the runtime proposes only while the session-only
 *  `agentEnabled` latch is on (cleared on restart, audited); a missing or exhausted
 *  GEMINI_API_KEY degrades to no agents; a hard daily request cap stops all model calls;
 *  malformed model output is journaled as a rejection, never guessed into a proposal. */
export class AgentRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures: string[] = [];
  private busy = false;
  private lastTickAt: string | null = null;

  constructor(
    private store: Store,
    private journal: DecisionJournal,
    private context: AgentContextProvider,
    private geminiFetch: typeof fetch,
    private options: AgentRuntimeOptions = {},
  ) {
    if (!Number.isInteger(this.cap) || this.cap < 3) throw new Error('Invalid daily request cap');
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 30000) throw new Error('Agent tick interval must be >= 30000ms');
  }

  private get agents(): AgentPersona[] { return this.options.agents ?? DEFAULT_AGENTS; }
  private get intervalMs(): number { return this.options.intervalMs ?? 600000; }
  private get cap(): number { return this.options.dailyRequestCap ?? 500; }
  private nowMs(): number { return this.options.now?.() ?? Date.now(); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private apiKey(): string | null {
    const key = process.env.GEMINI_API_KEY;
    return typeof key === 'string' && key.trim().length >= 20 ? key.trim() : null;
  }

  private dayKey(): string { return new Date(this.nowMs()).toISOString().slice(0, 10); }
  private requestsUsed(): number { return this.store.get(`agentRequests:${this.dayKey()}`) ?? 0; }

  enable(body: any) {
    if (!body || body.confirm !== 'ENABLE AGENT SHADOW') throw new Error('Type ENABLE AGENT SHADOW to confirm: agents propose in shadow mode only (no orders)');
    this.store.set('agentEnabled', true);
    this.store.audit('AGENT_SHADOW_ON', 'Operator enabled agent shadow mode for this session; no orders, journal-only');
    return this.status();
  }

  disable() {
    this.store.set('agentEnabled', false);
    this.store.audit('AGENT_SHADOW_OFF', 'Operator disabled agent shadow mode');
    return this.status();
  }

  status() {
    const pending = (this.store.get('agentShadowPending') ?? []) as PendingShadow[];
    return {
      enabled: !!this.store.get('agentEnabled'),
      apiKeyPresent: !!this.apiKey(),
      models: this.agents.map(a => ({ agentId: a.agentId, model: a.model })),
      requests: { day: this.dayKey(), used: this.requestsUsed(), cap: this.cap },
      pendingShadow: pending.length,
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt,
      failures: this.failures.slice(-5),
    };
  }

  /** One runtime cycle: expire old shadows, then (when enabled) ask every agent for every
   *  watched market, ensemble the valid proposals, journal, and open new shadows. */
  async tick(): Promise<{ ran: boolean; reason?: string; proposals?: number; rejections?: number; shadowsOpened?: number; shadowsClosed?: number }> {
    if (this.busy) return { ran: false, reason: 'tick already in flight' };
    this.busy = true;
    try {
      const shadowsClosed = this.expireShadows();
      if (!this.store.get('agentEnabled')) return { ran: false, reason: 'agent shadow mode is disabled', shadowsClosed };
      const key = this.apiKey();
      if (!key) { this.fail('GEMINI_API_KEY missing; agents idle'); return { ran: false, reason: 'GEMINI_API_KEY missing', shadowsClosed }; }
      const used = this.requestsUsed();
      if (used >= this.cap) {
        this.journalCap(used);
        return { ran: false, reason: `daily request cap reached (${used}/${this.cap})`, shadowsClosed };
      }
      const markets = this.context().slice(0, this.options.maxMarketsPerTick ?? 2);
      let proposals = 0, rejections = 0, shadowsOpened = 0;
      for (const market of markets) {
        const valid: AgentProposal[] = [];
        for (const agent of this.agents) {
          if (this.requestsUsed() >= this.cap) { this.journalCap(this.requestsUsed()); return this.finish(proposals, rejections, shadowsOpened, shadowsClosed); }
          try {
            const text = await this.askModel(agent, market, key);
            const fields = extractProposalJson(text);
            const proposal = buildProposal(fields, { id: crypto.randomUUID(), agentId: agent.agentId, symbol: market.symbol }, this.nowMs());
            this.journal.record({
              time: new Date(this.nowMs()).toISOString(), botId: agent.agentId, strategyId: 'agent-llm', symbol: market.symbol,
              decision: 'agent-proposal', rationale: `${proposal.direction} @ conf ${proposal.confidence.toFixed(2)}; horizon ${proposal.horizonSeconds}s; ${proposal.rationale}`.slice(0, 500),
              inputs: { expiresAt: proposal.expiresAt, mark: market.mark, model: agent.model },
              riskChecks: [{ check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' }],
            });
            valid.push(proposal);
            proposals++;
          } catch (error) {
            rejections++;
            this.journal.record({
              time: new Date(this.nowMs()).toISOString(), botId: agent.agentId, strategyId: 'agent-llm', symbol: market.symbol,
              decision: 'agent-reject', rationale: `model proposal rejected: ${(error as Error).message}`.slice(0, 500),
              riskChecks: [{ check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' }],
            });
          }
          this.store.set(`agentRequests:${this.dayKey()}`, this.requestsUsed() + 1);
        }
        const ensemble = ensembleDirection(valid);
        if (ensemble) {
          const id = crypto.randomUUID();
          this.journal.record({
            time: new Date(this.nowMs()).toISOString(), botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: market.symbol,
            decision: 'agent-proposal',
            rationale: `ensemble ${ensemble.direction} @ conf ${ensemble.confidence.toFixed(2)} (${ensemble.agreeing.join(' + ')}; dissent: ${ensemble.dissenting.join(', ') || 'none'}); shadow only`.slice(0, 500),
            inputs: { mark: market.mark, agreeing: ensemble.agreeing.join(', '), dissenting: ensemble.dissenting.join(', ') },
            riskChecks: [
              { check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' },
              { check: 'ensemble-quorum', pass: true, detail: `${ensemble.agreeing.length}-of-${this.agents.length}` },
            ],
          });
          this.openShadow({ id, agentId: 'agent-ensemble', symbol: market.symbol, direction: ensemble.direction,
            confidence: ensemble.confidence, markAt: market.mark,
            rationale: `${ensemble.direction} by ${ensemble.agreeing.join(' + ')}`,
            createdAt: new Date(this.nowMs()).toISOString(), expiresAtMs: this.nowMs() + 900 * 1000 });
          shadowsOpened++;
        } else {
          this.journal.record({
            time: new Date(this.nowMs()).toISOString(), botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: market.symbol,
            decision: 'skip', rationale: 'ensemble: no 2-of-3 agreement on a direction',
            riskChecks: [{ check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' }],
          });
        }
      }
      return this.finish(proposals, rejections, shadowsOpened, shadowsClosed);
    } finally { this.busy = false; }
  }

  private finish(proposals: number, rejections: number, shadowsOpened: number, shadowsClosed: number) {
    this.lastTickAt = new Date(this.nowMs()).toISOString();
    return { ran: true, proposals, rejections, shadowsOpened, shadowsClosed };
  }

  private journalCap(used: number) {
    const flag = `agentCapJournaled:${this.dayKey()}`;
    if (this.store.get(flag)) return;
    this.store.set(flag, true);
    this.journal.record({
      time: new Date(this.nowMs()).toISOString(), botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: 'all',
      decision: 'skip', rationale: `daily model request cap reached (${used}/${this.cap}); agents idle until tomorrow`,
      riskChecks: [{ check: 'daily-request-cap', pass: false, detail: `${used}/${this.cap}` }],
    });
  }

  private fail(message: string) {
    this.failures.push(message);
    while (this.failures.length > 10) this.failures.shift();
    this.store.audit('AGENT_RUNTIME_FAILURE', message);
  }

  private openShadow(shadow: PendingShadow) {
    const pending = (this.store.get('agentShadowPending') ?? []) as PendingShadow[];
    pending.push(shadow);
    while (pending.length > 200) pending.shift();
    this.store.set('agentShadowPending', pending);
  }

  private expireShadows(): number {
    const pending = (this.store.get('agentShadowPending') ?? []) as PendingShadow[];
    if (!pending.length) return 0;
    const nowMs = this.nowMs();
    const due = pending.filter(p => p.expiresAtMs <= nowMs);
    if (!due.length) return 0;
    const marks = new Map(this.context().map(m => [m.symbol, m.mark]));
    const remaining = pending.filter(p => {
      if (p.expiresAtMs > nowMs) return true;
      const markNow = marks.get(p.symbol);
      if (markNow === undefined) return true; // no fresh mark yet: retry next tick
      const signed = p.direction === 'long' ? 1 : -1;
      const movePct = signed * (markNow - p.markAt) / p.markAt * 100;
      this.journal.record({
        time: new Date(nowMs).toISOString(), botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: p.symbol,
        decision: 'agent-outcome',
        rationale: `${p.direction} ${p.symbol}: mark ${p.markAt.toFixed(2)} -> ${markNow.toFixed(2)} (${movePct >= 0 ? '+' : ''}${movePct.toFixed(3)}%) => ${movePct > 0 ? 'direction correct' : movePct < 0 ? 'direction wrong' : 'flat'} (shadow, no orders)`.slice(0, 500),
        inputs: { markAt: p.markAt, markAtExpiry: markNow, direction: p.direction, confidence: p.confidence, agents: p.agentId },
        riskChecks: [{ check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' }],
      });
      return false;
    });
    this.store.set('agentShadowPending', remaining);
    return pending.length - remaining.length;
  }

  private async askModel(agent: AgentPersona, market: AgentMarketContext, key: string): Promise<string> {
    const context = { symbol: market.symbol, mark: market.mark, fundingRate: market.fundingRate, accountEquity: market.equity, time: market.time };
    const prompt = `${agent.persona}\n\nCurrent market context (JSON):\n${JSON.stringify(context)}\n\n` +
      'Respond with ONLY a JSON object, no markdown fences, exactly this shape:\n' +
      '{"direction":"long"|"short"|"flat","confidence":0.0,"horizonSeconds":900,"rationale":"max 300 chars"}\n' +
      'direction is your opinion for the NEXT horizonSeconds (300..3600). confidence 0..1. You may answer flat.';
    let response: Response;
    for (let attempt = 1; ; attempt++) {
      response = await this.geminiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${agent.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 512 } }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30000),
      });
      if (response.ok) break;
      if ((response.status === 429 || response.status === 503) && attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
      throw new Error(`model HTTP ${response.status}`);
    }
    const body = await response.json() as any;
    const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
    return String(text);
  }
}

/** Extract + validate the model-supplied proposal fields from raw model text.
 *  Strips markdown fences if present; anything malformed throws (journaled upstream). */
export function extractProposalJson(text: string): { direction: 'long' | 'short' | 'flat'; confidence: number; horizonSeconds: number; rationale: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model response');
  const raw = JSON.parse(cleaned.slice(start, end + 1));
  return validateProposalFields(raw);
}

/** Re-export for tests/operator tooling: stale stored shadows are re-validated on load. */
export { validateStoredProposal };
