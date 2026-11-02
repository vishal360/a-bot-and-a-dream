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

export function evaluatePromotion(journal: DecisionJournal, thresholds = PROMOTION_THRESHOLDS): PromotionEvaluation {
  const stats = ensemblePromotionStats(journal);
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
    const evaluation = evaluatePromotion(this.journal, this.thresholds);
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
    const evaluation = evaluatePromotion(this.journal, this.thresholds);
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
