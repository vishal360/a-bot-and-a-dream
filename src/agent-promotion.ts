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
};

export type PromotionEvaluation = {
  eligible: boolean;
  stats: PromotionStats;
  shortfalls: string[];
};

export const UNLOCK_PHRASE = 'ENABLE AGENT PAPER ORDERS';

/** Cumulative gate memory (`agentGateStats` in the store): the decision journal is a
 *  bounded 5,000-entry ring, so a promotion gate that reads ONLY the journal would
 *  see its graded count SHRINK as old outcomes roll off — a dishonest regression.
 *  One store row per UTC day (kept 90 days) accumulates the ensemble's graded
 *  outcomes forever; the journal remains the display window. */
export type GateDayStats = { graded: number; correct: number };
export type GateStatsStore = { byDay: Record<string, GateDayStats> };
const GATE_STATS_KEY = 'agentGateStats';

export function recordGateOutcome(store: Store, dayIso: string, correct: boolean): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayIso)) throw new Error('Invalid gate stats day');
  const cur = (store.get(GATE_STATS_KEY) as GateStatsStore | undefined) ?? { byDay: {} };
  const day = cur.byDay[dayIso] ?? { graded: 0, correct: 0 };
  day.graded += 1;
  if (correct) day.correct += 1;
  cur.byDay[dayIso] = day;
  const days = Object.keys(cur.byDay).sort();
  while (days.length > 90) delete cur.byDay[days.shift()!];
  store.set(GATE_STATS_KEY, cur);
}

function aggregateGate(byDay: Record<string, GateDayStats>): PromotionStats {
  let graded = 0, correct = 0;
  const days = Object.keys(byDay).sort();
  for (const d of days) { graded += byDay[d].graded; correct += byDay[d].correct; }
  return { graded, correct, hitRate: graded ? correct / graded : null, distinctDays: days.length, window: { first: days[0] ?? null, last: days[days.length - 1] ?? null } };
}

/** Store-backed stats when available; on first use, seeds the store from the journal
 *  window exactly once so the pre-upgrade record is not lost. */
export function loadGateStats(store: Store, journal: DecisionJournal): PromotionStats {
  const stored = store.get(GATE_STATS_KEY) as GateStatsStore | undefined;
  if (stored && Object.keys(stored.byDay ?? {}).length) return aggregateGate(stored.byDay);
  const entries = journal.list({ botId: 'agent-ensemble', limit: 1000 }).filter(e => e.decision === 'agent-outcome');
  const byDay: Record<string, GateDayStats> = {};
  for (const e of entries) {
    const d = String(e.time).slice(0, 10);
    byDay[d] ??= { graded: 0, correct: 0 };
    byDay[d].graded++;
    if (e.inputs?.grade === 'correct') byDay[d].correct++;
  }
  if (Object.keys(byDay).length) store.set(GATE_STATS_KEY, { byDay });
  return aggregateGate(byDay);
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
  if (stats.graded < thresholds.minGraded) shortfalls.push(`graded outcomes ${stats.graded}/${thresholds.minGraded}`);
  if (stats.hitRate === null || stats.hitRate < thresholds.minHitRate) {
    shortfalls.push(`hit rate ${stats.hitRate === null ? 'n/a' : `${(stats.hitRate * 100).toFixed(1)}%`}/${(thresholds.minHitRate * 100).toFixed(0)}%`);
  }
  if (stats.distinctDays < thresholds.minDays) shortfalls.push(`distinct days ${stats.distinctDays}/${thresholds.minDays}`);
  return { eligible: shortfalls.length === 0, stats, shortfalls };
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
