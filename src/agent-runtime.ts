import type { Store } from './store';
import type { DecisionJournal } from './journal';
import { existsSync, readFileSync } from 'node:fs';
import { buildProposal, validateProposalFields, validateStoredProposal, type AgentProposal } from './agent-contract';
import { ensembleDirection } from './agent-ensemble';
import { AgentPromotion, recordGateOutcome } from './agent-promotion';

export type AgentMarketContext = {
  symbol: string; mark: number; fundingRate: number | null; equity: number | null; time: string;
};
export type AgentContextProvider = () => AgentMarketContext[];
export type AgentPersona = { agentId: string; model: string; persona: string; fallbackModels?: string[] };

/** The locked agent roster: three independent proposal sources for the 2-of-3 ensemble.
 *  Deliberately cheap models on the free tier; the personas disagree by construction. */
export const DEFAULT_AGENTS: AgentPersona[] = [
  { agentId: 'agent-gemini-momentum', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.5-flash-lite'], persona: 'You are a short-horizon momentum analyst for crypto perpetuals. You favor continuation of the recent move when the data supports it.' },
  { agentId: 'agent-gemini-skeptic', model: 'gemini-3.5-flash-lite', fallbackModels: ['gemini-3.8-flash'], persona: 'You are a conservative risk analyst. You distrust continuation, look for exhaustion, and prefer flat unless the evidence is strong.' },
  { agentId: 'agent-gemini-flow', model: 'gemini-3.5-flash-lite', fallbackModels: ['gemini-3.8-flash'], persona: 'You are a market-microstructure analyst focused on funding, mark vs index relationships and short-term flow.' },
];
// Model roster current as of 2026-10-30: Google deprecated gemini-2.5-* for new keys
// (HTTP 404 "no longer available to new users"); 3.8-flash occasionally 503s under load
// (the runtime retries), 3.5-flash-lite serves reliably.

/** One open shadow opinion: the ENSEMBLE's formed direction, or an individual
 *  persona's raw vote. Both are graded at expiry against the real mark — the
 *  ensemble to judge the quorum mechanism, the personas to judge each analyst. */
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
  /** Paper executor for a PROMOTED ensemble (src/agent-promotion.ts). Undefined =
   *  no execution path exists at all: the gate can unlock but nothing ever fires. */
  execute?: (order: { id: string; symbol: string; side: 'buy' | 'sell'; quantity: number; agentId: string; reason: string }) => Promise<unknown>;
  /** Conformal calibration artifact (research/conformal_calibration.py) surfaced on /activity. */
  calibrationPath?: string;
};

/** The agent runtime (docs/AGENT_SETUP.md, build order steps 2-3): calls the configured
 *  Gemini models for proposals, builds expiring contracts, applies the 2-of-3 ensemble,
 *  journals everything (journal-as-agent-memory) and runs SHADOW MODE: proposals are
 *  recorded and graded at expiry against the real mark, but NOTHING is ever executed.
 *
 *  Accountability is per persona: EVERY valid persona proposal is tracked to expiry and
 *  graded individually (botId = the persona's agentId), alongside the ensemble grade —
 *  so the dashboard can show which analysts deserve trust and which do not.
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
  private readonly promotion: AgentPromotion;
  private personaStreaks: Record<string, number> = {};

  constructor(
    private store: Store,
    private journal: DecisionJournal,
    private context: AgentContextProvider,
    private geminiFetch: typeof fetch,
    private options: AgentRuntimeOptions = {},
  ) {
    if (!Number.isInteger(this.cap) || this.cap < 3) throw new Error('Invalid daily request cap');
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 30000) throw new Error('Agent tick interval must be >= 30000ms');
    // Restart discipline (docs/AGENT_SETUP.md): a session-only shadow latch never survives a
    // restart; a PERSISTED one does (the operator opted in at enable time). Agent EXECUTION
    // is always session-only: a restart re-locks the promotion gate, no exceptions.
    if (this.store.get('agentEnabled') && this.store.get('agentShadowPersist') !== true) {
      this.store.set('agentEnabled', false);
      this.store.audit('AGENT_AUTOMATION_OFF', 'Restart cleared the session-only agent shadow authorization');
    }
    if (this.store.get('agentExecEnabled')) {
      this.store.set('agentExecEnabled', false);
      this.store.audit('AGENT_EXECUTION_OFF', 'Restart locked agent paper execution; the promotion gate must be re-unlocked');
    }
    this.promotion = new AgentPromotion(this.store, this.journal);
    this.personaStreaks = (this.store.get('agentPersonaStreaks') ?? {}) as Record<string, number>;
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
    const persist = body.persist === true;
    this.store.set('agentEnabled', true);
    this.store.set('agentShadowPersist', persist);
    this.store.audit('AGENT_SHADOW_ON', persist
      ? 'Operator enabled agent shadow mode; PERSIST across restarts (journal-only, no orders)'
      : 'Operator enabled agent shadow mode for this session; no orders, journal-only');
    return this.status();
  }

  disable() {
    this.store.set('agentEnabled', false);
    this.store.audit('AGENT_SHADOW_OFF', 'Operator disabled agent shadow mode');
    return this.status();
  }

  /** Shadow-to-paper promotion gate (src/agent-promotion.ts): unlock requires the exact
   *  phrase AND an eligible graded record; lock() re-locks at any time; restarts re-lock. */
  unlock(body: any) { return this.promotion.unlock(body); }
  lock() { return this.promotion.lock(); }

  /** Dashboard feed (GET /api/agents/activity): runtime status + the agent-memory
   *  journal + the live marks needed to grade open opinions client-side. */
  activity(limit = 150) {
    let marks: Record<string, number> = {};
    try { marks = Object.fromEntries(this.context().map(m => [m.symbol, m.mark])); } catch { marks = {}; }
    return {
      status: this.status(),
      entries: this.journal.listByBotPrefix('agent-', limit),
      marks,
      calibration: this.readCalibration(),
      open: {
        ensemble: (this.store.get('agentShadowPending') ?? []) as PendingShadow[],
        personas: (this.store.get('agentPersonaPending') ?? []) as PendingShadow[],
      },
    };
  }

  status() {
    const pending = (this.store.get('agentShadowPending') ?? []) as PendingShadow[];
    const personas = (this.store.get('agentPersonaPending') ?? []) as PendingShadow[];
    return {
      enabled: !!this.store.get('agentEnabled'),
      shadowPersist: this.store.get('agentShadowPersist') === true,
      apiKeyPresent: !!this.apiKey(),
      models: this.agents.map(a => ({ agentId: a.agentId, model: a.model })),
      requests: { day: this.dayKey(), used: this.requestsUsed(), cap: this.cap },
      pendingShadow: pending.length,
      pendingShadowList: pending,
      personaPending: personas.length,
      personaPendingList: personas,
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt,
      failures: this.failures.slice(-5),
      execution: this.promotion.status(),
      darkPersonas: Object.fromEntries(Object.entries(this.personaStreaks).filter(([, n]) => n >= 5)),
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
            const { text, model: usedModel } = await this.askModel(agent, market, key);
            const fields = extractProposalJson(text);
            const proposal = buildProposal(fields, { id: crypto.randomUUID(), agentId: agent.agentId, symbol: market.symbol }, this.nowMs());
            this.journal.record({
              time: new Date(this.nowMs()).toISOString(), botId: agent.agentId, strategyId: 'agent-llm', symbol: market.symbol,
              decision: 'agent-proposal', rationale: `${proposal.direction} @ conf ${proposal.confidence.toFixed(2)}; horizon ${proposal.horizonSeconds}s; ${proposal.rationale}`.slice(0, 500),
              inputs: { direction: proposal.direction, confidence: proposal.confidence, horizonSeconds: proposal.horizonSeconds, expiresAt: proposal.expiresAt, mark: market.mark, model: usedModel },
              riskChecks: [{ check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' }],
            });
            this.trackPersona(proposal, market.mark);
            if (this.personaStreaks[agent.agentId]) { this.personaStreaks[agent.agentId] = 0; this.store.set('agentPersonaStreaks', this.personaStreaks); }
            valid.push(proposal);
            proposals++;
          } catch (error) {
            rejections++;
            this.personaStreaks[agent.agentId] = (this.personaStreaks[agent.agentId] ?? 0) + 1;
            this.store.set('agentPersonaStreaks', this.personaStreaks);
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
          const priorForSymbol = ((this.store.get('agentShadowPending') ?? []) as PendingShadow[]).filter(p => p.agentId === 'agent-ensemble' && p.symbol === market.symbol).length;
          this.journal.record({
            time: new Date(this.nowMs()).toISOString(), botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: market.symbol,
            decision: 'agent-proposal',
            rationale: `ensemble ${ensemble.direction} @ conf ${ensemble.confidence.toFixed(2)} (${ensemble.agreeing.join(' + ')}; dissent: ${ensemble.dissenting.join(', ') || 'none'}); shadow only`.slice(0, 500),
            inputs: { direction: ensemble.direction, confidence: ensemble.confidence, mark: market.mark, agreeing: ensemble.agreeing.join(', '), dissenting: ensemble.dissenting.join(', ') },
            riskChecks: [
              { check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' },
              { check: 'ensemble-quorum', pass: true, detail: `${ensemble.agreeing.length}-of-${this.agents.length}` },
            ],
          });
          this.openShadow({ id, agentId: 'agent-ensemble', symbol: market.symbol, direction: ensemble.direction,
            confidence: ensemble.confidence, markAt: market.mark,
            rationale: `${ensemble.direction} by ${ensemble.agreeing.join(' + ')}`,
            createdAt: new Date(this.nowMs()).toISOString(), expiresAtMs: this.nowMs() + 900 * 1000 });
          void this.maybeExecute(ensemble, market, priorForSymbol);
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

  /** Every valid persona proposal is tracked to expiry for per-analyst accountability. */
  private trackPersona(proposal: AgentProposal, markAt: number) {
    if (proposal.direction === 'flat') return; // flat votes carry no gradeable direction
    const pending = (this.store.get('agentPersonaPending') ?? []) as PendingShadow[];
    pending.push({ id: proposal.id, agentId: proposal.agentId, symbol: proposal.symbol,
      direction: proposal.direction, confidence: proposal.confidence, markAt,
      rationale: proposal.rationale, createdAt: proposal.createdAt,
      expiresAtMs: this.nowMs() + proposal.horizonSeconds * 1000 });
    while (pending.length > 300) pending.shift();
    this.store.set('agentPersonaPending', pending);
  }

  /** Grade every expired shadow — ensemble AND per-persona — against the fresh mark.
   *  No fresh mark for a symbol: the opinion stays open and retries next tick. */
  private expireShadows(): number {
    const nowMs = this.nowMs();
    const marks = new Map(this.context().map(m => [m.symbol, m.mark]));
    let closed = 0;
    closed += this.expireList('agentShadowPending', 'agent-ensemble', marks, nowMs);
    closed += this.expireList('agentPersonaPending', undefined, marks, nowMs);
    return closed;
  }

  /** Grade one pending list. `fixedBotId` set = ensemble list (all outcomes under
   *  agent-ensemble); undefined = per-persona list (each outcome under its own agentId). */
  private expireList(storeKey: string, fixedBotId: string | undefined, marks: Map<string, number>, nowMs: number): number {
    const pending = (this.store.get(storeKey) ?? []) as PendingShadow[];
    if (!pending.length) return 0;
    const remaining = pending.filter(p => {
      if (p.expiresAtMs > nowMs) return true;
      const markNow = marks.get(p.symbol);
      if (markNow === undefined) return true; // no fresh mark yet: retry next tick
      const botId = fixedBotId ?? p.agentId;
      const signed = p.direction === 'long' ? 1 : -1;
      const movePct = signed * (markNow - p.markAt) / p.markAt * 100;
      this.journal.record({
        time: new Date(nowMs).toISOString(), botId, strategyId: 'agent-llm', symbol: p.symbol,
        decision: 'agent-outcome',
        rationale: `${p.direction} ${p.symbol}: mark ${p.markAt.toFixed(2)} -> ${markNow.toFixed(2)} (${movePct >= 0 ? '+' : ''}${movePct.toFixed(3)}%) => ${movePct > 0 ? 'direction correct' : movePct < 0 ? 'direction wrong' : 'flat'} (shadow, no orders)`.slice(0, 500),
        inputs: { markAt: p.markAt, markAtExpiry: markNow, direction: p.direction, confidence: p.confidence, agents: p.agentId, grade: movePct > 0 ? 'correct' : movePct < 0 ? 'wrong' : 'flat' },
        riskChecks: [{ check: 'shadow-mode', pass: true, detail: 'no orders; journal-only' }],
      });
      if (fixedBotId === 'agent-ensemble') {
        // Cumulative gate memory: the journal is a bounded ring, so the promotion gate
        // must NOT depend on it for history. One store row per UTC day survives forever.
        recordGateOutcome(this.store, new Date(nowMs).toISOString().slice(0, 10), movePct > 0);
      }
      return false;
    });
    this.store.set(storeKey, remaining);
    return pending.length - remaining.length;
  }

  /** Ask one persona for a proposal, walking its model chain when a model is
   *  unavailable (404) or overloaded (429/503). Returns the response text AND the
   *  model that actually served it — the journal records the truth, not the plan. */
  private async askModel(agent: AgentPersona, market: AgentMarketContext, key: string): Promise<{ text: string; model: string }> {
    const context = { symbol: market.symbol, mark: market.mark, fundingRate: market.fundingRate, accountEquity: market.equity, time: market.time };
    const prompt = `${agent.persona}${this.memoryBlock(agent.agentId)}\n\nCurrent market context (JSON):\n${JSON.stringify(context)}\n\n` +
      'Respond with ONLY a JSON object, no markdown fences, exactly this shape:\n' +
      '{"direction":"long"|"short"|"flat","confidence":0.0,"horizonSeconds":900,"rationale":"max 300 chars"}\n' +
      'direction is your opinion for the NEXT horizonSeconds (300..3600). confidence 0..1. You may answer flat.';
    const models = [agent.model, ...(agent.fallbackModels ?? [])];
    let lastError: Error = new Error('no model configured');
    for (const model of models) {
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await this.geminiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 512 } }),
            signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30000),
          });
          if (response.ok) {
            const body = await response.json() as any;
            const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
            return { text: String(text), model };
          }
          if ((response.status === 429 || response.status === 503) && attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
          lastError = new Error(`model ${model} HTTP ${response.status}`);
          break; // this model is unavailable: fall through to the next in the chain
        } catch (error) {
          lastError = error as Error;
          break; // network/abort on this model: the chain ends here this cycle
        }
      }
    }
    throw lastError;
  }

  /** Promoted-ensemble execution: at most ONE paper order per quorum per symbol while
   *  no ensemble opinion is already open for that symbol. Sized from account equity and
   *  the audited agentAllocationPct envelope — the paper executor re-enforces the
   *  envelope itself (fail-closed at 0), so this sizing can only ever be MORE
   *  conservative than policy. Every attempt journals. */
  private async maybeExecute(
    ensemble: { direction: 'long' | 'short'; confidence: number; agreeing: string[] },
    market: AgentMarketContext,
    priorForSymbol: number,
  ) {
    if (!this.store.get('agentExecEnabled')) return;
    if (priorForSymbol > 0) return; // one open opinion per symbol: no pyramiding
    const execute = this.options.execute;
    if (!execute) { this.journalExecution('agent-reject', market, 'execution unavailable: no executor is wired into this runtime'); return; }
    const equity = market.equity ?? 0;
    if (!Number.isFinite(equity) || equity <= 0) { this.journalExecution('agent-reject', market, 'no account equity available for sizing'); return; }
    const pct = this.store.get('agentAllocationPct');
    if (!Number.isInteger(pct) || (pct as number) < 1) { this.journalExecution('agent-reject', market, 'agent allocation envelope is not set'); return; }
    const notionalUsd = equity * (pct as number) / 100;
    const quantity = Number((notionalUsd / market.mark).toFixed(4));
    if (!(quantity > 0)) { this.journalExecution('agent-reject', market, 'sizing rounded to zero'); return; }
    const side = ensemble.direction === 'long' ? 'buy' : 'sell';
    const reason = `ensemble ${ensemble.direction} @ conf ${ensemble.confidence.toFixed(2)} (${ensemble.agreeing.join(' + ')})`;
    try {
      await execute({ id: `agent-${crypto.randomUUID()}`, symbol: market.symbol, side, quantity, agentId: 'agent-ensemble', reason });
      this.journalExecution('agent-order', market, `paper ${side} ${quantity} ${market.symbol} (envelope ${pct}%): ${reason}`.slice(0, 500), { side, quantity, price: market.mark });
    } catch (error) {
      this.journalExecution('agent-reject', market, `paper order rejected: ${(error as Error).message}`.slice(0, 480));
    }
  }

  private journalExecution(kind: 'agent-order' | 'agent-reject', market: AgentMarketContext, rationale: string, numbers?: { side: 'buy' | 'sell'; quantity: number; price: number }) {
    try {
      this.journal.record({
        time: new Date(this.nowMs()).toISOString(), botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: market.symbol,
        decision: kind, side: numbers?.side ?? null, quantity: numbers?.quantity ?? null, price: numbers?.price ?? null,
        rationale, riskChecks: [{ check: 'promotion-gate', pass: kind === 'agent-order', detail: 'agentExecEnabled session latch' }],
      });
    } catch { /* journaling must never crash the tick */ }
  }

  /** Journal-as-agent-memory (docs/AGENT_SETUP.md): the persona's own last graded shadow
   *  outcomes, oldest first, so each analyst can learn from its scored record. Bounded
   *  to 10 outcomes; no history means an empty block — memory is never invented. */
  private memoryBlock(agentId: string): string {
    try {
      const outcomes = this.journal.list({ botId: agentId, limit: 60 })
        .filter(e => e.decision === 'agent-outcome' && e.inputs && typeof (e.inputs as any).grade === 'string')
        .slice(0, 10);
      if (!outcomes.length) return '';
      const lines = outcomes.reverse().map(e => {
        const i = e.inputs as { direction?: string; grade?: string; markAt?: number; markAtExpiry?: number };
        const move = typeof i.markAt === 'number' && typeof i.markAtExpiry === 'number' && i.markAt > 0
          ? ((i.direction === 'long' ? 1 : -1) * (i.markAtExpiry - i.markAt) / i.markAt * 100)
          : null;
        const verdict = i.grade === 'correct' ? 'CORRECT' : i.grade === 'wrong' ? 'WRONG' : 'FLAT';
        return `- ${(i.direction ?? '?').toUpperCase()} ${verdict}${move !== null ? ` (move ${move >= 0 ? '+' : ''}${move.toFixed(2)}%)` : ''}`;
      });
      return `\n\nYour recent graded outcomes (oldest first, graded against the real mark at expiry):\n${lines.join('\n')}\nRepeat what worked; do not repeat what failed.`;
    } catch { return ''; }
  }

  /** Conformal calibration widths per persona (research/conformal_calibration.py output).
   *  Missing or broken artifact = null: the UI shows nothing rather than guessing. */
  private readCalibration(): Record<string, unknown> | null {
    const path = this.options.calibrationPath ?? 'research/calibration.json';
    try {
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
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
