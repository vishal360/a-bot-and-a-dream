import type { Store } from './store';

export type DecisionKind =
  | 'bot-create' | 'bot-update' | 'bot-delete' | 'bot-start' | 'bot-pause' | 'bot-halt'
  | 'propose' | 'skip' | 'submit' | 'fill' | 'partial' | 'reject'
  | 'guard-pause' | 'guard-resume' | 'automation-enable' | 'automation-disable'
  | 'agent-proposal' | 'agent-reject' | 'agent-outcome';
export type RiskCheck = { check: string; pass: boolean; detail?: string };
export type DecisionInput = Record<string, number | string | boolean | null>;

export type DecisionEntry = {
  time: string; botId: string; strategyId: string; strategyHash?: string | null; symbol: string;
  decision: DecisionKind; side?: 'buy' | 'sell' | null; quantity?: number | null; price?: number | null;
  rationale?: string | null; inputs?: DecisionInput | null; riskChecks?: RiskCheck[] | null;
  orderId?: string | null; error?: string | null;
};

const SYMBOL = /^[A-Za-z0-9._/-]{1,80}$/;
const ID = /^[a-z0-9-]{3,40}$/;
const STRATEGY = /^[a-z0-9-]{2,60}$/;
const KINDS: DecisionKind[] = ['bot-create', 'bot-update', 'bot-delete', 'bot-start', 'bot-pause', 'bot-halt',
  'propose', 'skip', 'submit', 'fill', 'partial', 'reject', 'guard-pause', 'guard-resume', 'automation-enable', 'automation-disable',
  'agent-proposal', 'agent-reject', 'agent-outcome'];
const bounded = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;

/** Append-only bounded log of every automated decision, its inputs and its risk checks.
 *  Local evidence, not tamper-proof: local administrators can alter the database. */
export class DecisionJournal {
  constructor(private store: Store, private limit = 5000) {
    if (!Number.isInteger(limit) || limit < 100 || limit > 100000) throw new Error('Invalid journal limit');
    store.db.exec(`CREATE TABLE IF NOT EXISTS decision_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, bot_id TEXT NOT NULL, strategy_id TEXT NOT NULL,
      strategy_hash TEXT, symbol TEXT NOT NULL, decision TEXT NOT NULL, side TEXT, quantity REAL, price REAL,
      rationale TEXT, inputs TEXT, risk_checks TEXT, order_id TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS decision_journal_bot ON decision_journal (bot_id, id);`);
  }
  record(entry: DecisionEntry) {
    if (!(entry.time && Date.parse(entry.time)) || !ID.test(entry.botId) || !STRATEGY.test(entry.strategyId) ||
        !SYMBOL.test(entry.symbol) || !KINDS.includes(entry.decision)) throw new Error('Invalid journal entry');
    if (entry.side != null && !['buy', 'sell'].includes(entry.side)) throw new Error('Invalid journal side');
    for (const n of [entry.quantity, entry.price]) if (n != null && (!Number.isFinite(n) || n < 0 || n > 1e12)) throw new Error('Invalid journal number');
    if (entry.rationale != null && (typeof entry.rationale !== 'string' || entry.rationale.length > 500)) throw new Error('Journal rationale missing or exceeds 500 chars');
    if (entry.error != null && (typeof entry.error !== 'string' || entry.error.length > 500)) throw new Error('Journal error missing or exceeds 500 chars');
    const inputs = entry.inputs ? JSON.stringify(entry.inputs) : null;
    if (inputs && inputs.length > 4096) throw new Error('Journal inputs exceed 4KB');
    const checks = entry.riskChecks ? JSON.stringify(entry.riskChecks) : null;
    if (checks && checks.length > 8192) throw new Error('Journal risk checks exceed 8KB');
    this.store.db.transaction(() => {
      this.store.db.query(`INSERT INTO decision_journal (time,bot_id,strategy_id,strategy_hash,symbol,decision,side,quantity,price,rationale,inputs,risk_checks,order_id,error)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(entry.time, entry.botId, entry.strategyId, bounded(entry.strategyHash ?? null, 128), entry.symbol,
        entry.decision, entry.side ?? null, entry.quantity ?? null, entry.price ?? null, entry.rationale ?? null,
        inputs, checks, bounded(entry.orderId ?? null, 80), entry.error ?? null);
      this.store.db.query('DELETE FROM decision_journal WHERE id < (SELECT id FROM decision_journal ORDER BY id DESC LIMIT 1 OFFSET ?)').run(this.limit - 1);
    }).immediate();
  }
  list(options: { botId?: string; limit?: number } = {}) {
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid journal query limit');
    if (options.botId !== undefined && !ID.test(options.botId)) throw new Error('Invalid bot ID');
    const rows = options.botId
      ? this.store.db.query('SELECT * FROM decision_journal WHERE bot_id=? ORDER BY id DESC LIMIT ?').all(options.botId, limit)
      : this.store.db.query('SELECT * FROM decision_journal ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as any[]).map(r => ({ ...r, inputs: r.inputs ? JSON.parse(r.inputs) : null, risk_checks: r.risk_checks ? JSON.parse(r.risk_checks) : null }));
  }
  /** Agent-memory queries: every journal row for bot ids starting with the prefix
   *  (e.g. 'agent-' matches agent-gemini-* and agent-ensemble). Validated prefix,
   *  bounded limit; feeds GET /api/agents/activity. */
  listByBotPrefix(prefix: string, limit: number) {
    if (!/^[a-z0-9-]{3,30}$/.test(prefix)) throw new Error('Invalid journal bot prefix');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid journal query limit');
    return (this.store.db.query('SELECT * FROM decision_journal WHERE bot_id LIKE ? ORDER BY id DESC LIMIT ?').all(prefix + '%', limit) as any[]).map(r => ({ ...r, inputs: r.inputs ? JSON.parse(r.inputs) : null, risk_checks: r.risk_checks ? JSON.parse(r.risk_checks) : null }));
  }
  count(botId: string, sinceIso: string) {
    if (!ID.test(botId) || !(Date.parse(sinceIso))) throw new Error('Invalid journal count query');
    return (this.store.db.query("SELECT COUNT(*) AS n FROM decision_journal WHERE bot_id=? AND decision IN ('submit','fill','partial') AND time>=?").get(botId, sinceIso) as any).n;
  }
}
