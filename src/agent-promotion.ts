import type { Store } from './store';
import type { DecisionJournal } from './journal';

/** The operator-approved promotion thresholds (2026-11-02): the ensemble may trade
 *  paper orders only after its SHADOW record proves the edge — at least minGraded
 *  graded outcomes, a hit rate of at least minHitRate, spread over at least minDays
 *  distinct UTC days. Allocation is hard-capped at maxAllocationPct of equity.
 *  These numbers are policy, not code preference: changing them is an operator
 *  decision and an audit event, never a convenience. */
export const PROMOTION_THRESHOLDS = {
  minGraded: 100,
  minHitRate: 0.55,
  minDays: 3,
  maxAllocationPct: 2,
} as const;

export type PromotionStats = {
  graded: number;
  correct: number;
  hitRate: number | null;
  distinctDays: number;
  window: { first: string | null; last: string | null };
  /** Mean direction-signed move per graded outcome (expectancy of the direction call
   *  before costs — accuracy is not profitability, so this is displayed beside it). */
  meanSignedMovePct?: number | null;
  /** Invalid persisted evidence must never qualify the gate. */
  integrityError?: string;
};

export type PromotionEvaluation = {
  eligible: boolean;
  stats: PromotionStats;
  shortfalls: string[];
  statistics: {
    binomialPValueUnderFairCoin: number | null;
    meanSignedMovePct: number | null;
    note: string;
  };
};

/** Exact one-sided binomial upper tail P(X >= successes | n, fair coin); normal
 *  approximation beyond 500 trials. Answers: how surprising is this hit rate if the
 *  analyst were a fair coin? (Review P0-08: 55/100 gives ~0.184 — not evidence.) */
function exactBinomialUpperTail(successes: number, n: number, p = 0.5): number | null {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n <= 0 || successes < 0 || successes > n) return null;
  if (n <= 500) {
    let tail = 0;
    for (let k = successes; k <= n; k++) {
      let logChoose = 0;
      for (let j = 1; j <= k; j++) logChoose += Math.log((n - j + 1) / j);
      tail += Math.exp(k * Math.log(p) + (n - k) * Math.log(1 - p) + logChoose);
    }
    return Math.min(1, tail);
  }
  const mean = n * p, sd = Math.sqrt(n * p * (1 - p));
  const z = (successes - mean) / sd;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = 0.319381530 * t - 0.356563782 * t ** 2 + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5;
  const cdf = 1 - Math.exp(-z * z / 2) * poly / Math.sqrt(2 * Math.PI);
  return Math.min(1, Math.max(0, z >= 0 ? 1 - cdf : cdf));
}

export const UNLOCK_PHRASE = 'ENABLE AGENT PAPER ORDERS';

/** Lifetime evidence is independent of both the journal ring and recent-form rows. */
export type GateDayStats = { graded: number; correct: number };
export type GateStatsStore = {
  lifetime: { graded: number; correct: number; days: number; sumMovePct: number | null; firstDay: string; lastDay: string };
  byDay: Record<string, GateDayStats>;
  /** Never pruned: revisiting an evicted display day is not a new distinct day. */
  seenDays: string[];
  /** Older lifetime rows may have already lost identities. Unknown interior days
   *  cannot safely be counted again; new days beyond the old window still can. */
  unknownDayWindow?: { first: string; last: string };
};
const GATE_STATS_KEY = 'agentGateStats';
const GATE_DAYS_KEPT = 90;
const readGateRaw = (store: Store): unknown => store.db.query('SELECT 1 FROM state WHERE key=?').get(GATE_STATS_KEY)
  ? store.get(GATE_STATS_KEY) : undefined;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const validDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const emptyStats = (integrityError?: string): PromotionStats => ({ graded: 0, correct: 0, hitRate: null,
  distinctDays: 0, window: { first: null, last: null }, meanSignedMovePct: null, ...(integrityError ? { integrityError } : {}) });

/** Validate untrusted store JSON before either migration or arithmetic. Invalid
 *  evidence is retained for diagnosis, never silently replaced with a smaller seed. */
function normalizeGate(raw: unknown): GateStatsStore {
  if (!object(raw) || !object(raw.byDay)) throw new Error('Invalid gate stats');
  const keys = Object.keys(raw.byDay).sort();
  let graded = 0, correct = 0;
  for (const d of keys) {
    const row = raw.byDay[d];
    if (!validDay(d) || !object(row) || !counter(row.graded) || row.graded === 0 || !counter(row.correct) || row.correct > row.graded) throw new Error('Invalid gate day counters');
    graded += row.graded; correct += row.correct;
  }
  if (!counter(graded) || !counter(correct)) throw new Error('Invalid gate totals');
  let life = raw.lifetime;
  if (life === undefined) {
    // Legacy byDay is authoritative even if more extensive than surviving history.
    if (!keys.length) throw new Error('Empty legacy gate stats');
    life = { graded, correct, days: keys.length, sumMovePct: null, firstDay: keys[0], lastDay: keys[keys.length - 1] };
  }
  if (!object(life) || !counter(life.graded) || !counter(life.correct) || life.correct > life.graded
    || !counter(life.days) || life.days > life.graded || life.days < keys.length
    || life.graded < graded || life.correct < correct || life.graded - life.correct < graded - correct
    || !validDay(life.firstDay) || !validDay(life.lastDay) || life.firstDay > life.lastDay
    || life.days > (Date.parse(`${life.lastDay}T00:00:00Z`) - Date.parse(`${life.firstDay}T00:00:00Z`)) / 86400000 + 1
    || (life.graded > 0 && life.days === 0) || (life.days === 1 && life.firstDay !== life.lastDay)
    || keys.some(d => d < life.firstDay || d > life.lastDay)
    || !(life.sumMovePct === undefined || life.sumMovePct === null || (typeof life.sumMovePct === 'number' && Number.isFinite(life.sumMovePct)))) throw new Error('Invalid gate lifetime counters');
  let seenDays: string[];
  let unknownDayWindow = raw.unknownDayWindow;
  if (raw.seenDays === undefined) {
    seenDays = [...new Set([...keys, ...(life.days ? [life.firstDay, life.lastDay] : [])])].sort();
    if (seenDays.length < life.days) unknownDayWindow = { first: life.firstDay, last: life.lastDay };
  } else {
    if (!Array.isArray(raw.seenDays) || raw.seenDays.some(d => !validDay(d))) throw new Error('Invalid gate day identities');
    seenDays = [...new Set<string>(raw.seenDays)].sort();
    if (seenDays.length !== raw.seenDays.length || keys.some(d => !seenDays.includes(d))) throw new Error('Invalid gate day identities');
  }
  if (seenDays.some(d => d < life.firstDay || d > life.lastDay) || seenDays.length > life.graded) throw new Error('Invalid gate day bounds');
  if (unknownDayWindow !== undefined) {
    if (!object(unknownDayWindow) || !validDay(unknownDayWindow.first) || !validDay(unknownDayWindow.last)
      || unknownDayWindow.first > unknownDayWindow.last || unknownDayWindow.first < life.firstDay || unknownDayWindow.last > life.lastDay) throw new Error('Invalid gate legacy day window');
  } else if (seenDays.length !== life.days) throw new Error('Invalid gate distinct-day count');
  return { lifetime: { ...life, sumMovePct: life.sumMovePct ?? null } as GateStatsStore['lifetime'],
    byDay: { ...raw.byDay }, seenDays, ...(unknownDayWindow ? { unknownDayWindow } : {}) };
}

function pruneGate(cur: GateStatsStore): void {
  const days = Object.keys(cur.byDay).sort();
  while (days.length > GATE_DAYS_KEPT) delete cur.byDay[days.shift()!];
}

export function recordGateOutcome(store: Store, dayIso: string, correct: boolean, movePct?: number): void {
  if (!validDay(dayIso)) throw new Error('Invalid gate stats day');
  if (typeof correct !== 'boolean' || (movePct !== undefined && !Number.isFinite(movePct))) throw new Error('Invalid gate outcome');
  const raw = readGateRaw(store);
  const cur: GateStatsStore = raw === undefined ? {
    lifetime: { graded: 0, correct: 0, days: 0, sumMovePct: 0, firstDay: dayIso, lastDay: dayIso }, byDay: {}, seenDays: [],
  } : normalizeGate(raw);
  cur.lifetime.graded += 1;
  if (correct) cur.lifetime.correct += 1;
  cur.lifetime.sumMovePct = cur.lifetime.sumMovePct !== null && movePct !== undefined ? cur.lifetime.sumMovePct + movePct : null;
  if (!cur.seenDays.includes(dayIso)) {
    const unknown = cur.unknownDayWindow;
    if (!unknown || dayIso < unknown.first || dayIso > unknown.last) cur.lifetime.days += 1;
    cur.seenDays.push(dayIso);
  }
  cur.lifetime.firstDay = cur.lifetime.firstDay <= dayIso ? cur.lifetime.firstDay : dayIso;
  cur.lifetime.lastDay = cur.lifetime.lastDay >= dayIso ? cur.lifetime.lastDay : dayIso;
  const day = cur.byDay[dayIso] ?? { graded: 0, correct: 0 };
  day.graded += 1;
  if (correct) day.correct += 1;
  cur.byDay[dayIso] = day;
  // Catch overflow as well as malformed input before persisting.
  normalizeGate(cur);
  pruneGate(cur);
  store.set(GATE_STATS_KEY, cur);
}

function aggregateGate(stored: GateStatsStore): PromotionStats {
  const life = stored.lifetime;
  return { graded: life.graded, correct: life.correct, hitRate: life.graded ? life.correct / life.graded : null,
    distinctDays: life.days, window: { first: life.graded ? life.firstDay : null, last: life.graded ? life.lastDay : null },
    meanSignedMovePct: life.graded && life.sumMovePct !== null ? life.sumMovePct / life.graded : null };
}

/** Existing memory wins over history. Only genuinely absent memory is seeded, using
 *  all pages of authoritative history rather than the bounded dashboard window. */
export function loadGateStats(store: Store, journal: DecisionJournal): PromotionStats {
  let raw: unknown;
  try { raw = readGateRaw(store); }
  catch { return emptyStats('Stored gate evidence is malformed; operator repair required'); }
  if (raw !== undefined) {
    try {
      const stored = normalizeGate(raw);
      pruneGate(stored);
      store.set(GATE_STATS_KEY, stored);
      return aggregateGate(stored);
    } catch { return emptyStats('Stored gate evidence is malformed; operator repair required'); }
  }
  let cursor = 0;
  for (;;) {
    const entries = journal.historySinceId(cursor, 1000);
    if (!entries.length) break;
    for (const e of entries) {
      cursor = e.id;
      if (e.bot_id !== 'agent-ensemble' || e.decision !== 'agent-outcome') continue;
      const i = e.inputs;
      const move = typeof i?.markAt === 'number' && Number.isFinite(i.markAt) && i.markAt > 0
        && typeof i.markAtExpiry === 'number' && Number.isFinite(i.markAtExpiry) && (i.direction === 'long' || i.direction === 'short')
        ? (i.direction === 'long' ? 1 : -1) * (i.markAtExpiry - i.markAt) / i.markAt * 100 : undefined;
      recordGateOutcome(store, String(e.time).slice(0, 10), i?.grade === 'correct', move);
    }
  }
  const seeded = readGateRaw(store);
  return seeded === undefined ? emptyStats() : aggregateGate(normalizeGate(seeded));
}

/** Reads the ENSEMBLE's graded shadow record (decision_journal rows where
 *  bot_id='agent-ensemble' and decision='agent-outcome'). Personas are deliberately
 *  NOT part of this gate: the ensemble is what would trade, so the ensemble is what
 *  must prove itself. Flat outcomes (a zero move at expiry) count in the denominator
 *  and never as correct — optimism is not allowed to leak in through rounding. */
export function ensemblePromotionStats(journal: DecisionJournal): PromotionStats {
  const entries = journal.list({ botId: 'agent-ensemble', limit: 1000 }).filter(e => e.decision === 'agent-outcome');
  const graded = entries.length;
  const correct = entries.filter(e => e.inputs?.grade === 'correct').length;
  const days = new Set(entries.map(e => String(e.time).slice(0, 10)));
  const times = entries.map(e => String(e.time)).sort();
  return {
    graded,
    correct,
    hitRate: graded ? correct / graded : null,
    distinctDays: days.size,
    window: { first: times[0] ?? null, last: times[times.length - 1] ?? null },
  };
}

export function evaluatePromotion(journal: DecisionJournal, thresholds = PROMOTION_THRESHOLDS, store?: Store): PromotionEvaluation {
  const stats = store ? loadGateStats(store, journal) : ensemblePromotionStats(journal);
  const shortfalls: string[] = [];
  if (stats.integrityError) shortfalls.push(stats.integrityError);
  if (stats.graded < thresholds.minGraded) shortfalls.push(`graded outcomes ${stats.graded}/${thresholds.minGraded}`);
  if (stats.hitRate === null || stats.hitRate < thresholds.minHitRate) {
    shortfalls.push(`hit rate ${stats.hitRate === null ? 'n/a' : `${(stats.hitRate * 100).toFixed(1)}%`}/${(thresholds.minHitRate * 100).toFixed(0)}%`);
  }
  if (stats.distinctDays < thresholds.minDays) shortfalls.push(`distinct days ${stats.distinctDays}/${thresholds.minDays}`);
  return { eligible: shortfalls.length === 0, stats, shortfalls, statistics: {
    binomialPValueUnderFairCoin: exactBinomialUpperTail(stats.correct, stats.graded, 0.5),
    meanSignedMovePct: (stats as any).meanSignedMovePct ?? null,
    note: 'Paper-experiment milestone, not live evidence: direction accuracy is not net profitability (fees, funding, sizing and exits are not in this grade), and overlapping horizons weaken independence.',
  } };
}

/** The shadow→paper gate. Everything here stays LOCAL PAPER trading: the paper
 *  executor is the only executor this codebase has. Fail-closed by construction:
 *  unlocked=false until unlock() succeeds, unlock() throws unless the record meets
 *  every threshold, the allocation can never exceed maxAllocationPct, and a restart
 *  clears the latch (the runtime constructor re-locks on boot — session-only). */
export class AgentPromotion {
  constructor(
    private store: Store,
    private journal: DecisionJournal,
    private thresholds = PROMOTION_THRESHOLDS,
  ) {}

  private get unlocked(): boolean { return this.store.get('agentExecEnabled') === true; }

  status() {
    const evaluation = evaluatePromotion(this.journal, this.thresholds, this.store);
    return {
      unlocked: this.unlocked,
      thresholds: this.thresholds,
      allocationPct: this.store.get('agentAllocationPct') ?? 0,
      stats: evaluation.stats,
      shortfalls: evaluation.shortfalls,
      eligible: evaluation.eligible,
      statistics: evaluation.statistics,
    };
  }

  /** Operator unlock: requires the exact confirmation phrase AND an eligible shadow
   *  record. The allocation is optional and clamped to [1, maxAllocationPct] — it can
   *  only ever be made SMALLER than policy, never larger. */
  unlock(body: any) {
    if (!body || body.confirm !== UNLOCK_PHRASE) throw new Error(`Type ${UNLOCK_PHRASE} to confirm: the agent ensemble may place PAPER orders inside its allocation envelope`);
    const evaluation = evaluatePromotion(this.journal, this.thresholds, this.store);
    if (!evaluation.eligible) throw new Error(`Promotion gate refuses: the shadow record does not meet the thresholds yet (${evaluation.shortfalls.join('; ')})`);
    let allocationPct = this.thresholds.maxAllocationPct;
    if (body?.allocationPct !== undefined) {
      if (!Number.isInteger(body.allocationPct) || body.allocationPct < 1 || body.allocationPct > this.thresholds.maxAllocationPct) {
        throw new Error(`allocationPct must be an integer between 1 and ${this.thresholds.maxAllocationPct}`);
      }
      allocationPct = body.allocationPct;
    }
    this.store.set('agentExecEnabled', true);
    this.store.set('agentAllocationPct', allocationPct);
    this.store.audit('AGENT_EXECUTION_ON', `Ensemble promoted to paper execution: allocation ${allocationPct}% (cap ${this.thresholds.maxAllocationPct}%), record ${evaluation.stats.correct}/${evaluation.stats.graded} over ${evaluation.stats.distinctDays} day(s)`);
    return this.status();
  }

  lock() {
    if (this.unlocked) this.store.audit('AGENT_EXECUTION_OFF', 'Operator locked agent paper execution');
    this.store.set('agentExecEnabled', false);
    return this.status();
  }
}
