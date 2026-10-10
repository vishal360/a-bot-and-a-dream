import { Database } from 'bun:sqlite';
import type { Bot, Result } from './domain';
export class Store {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // Paper settlements must survive power loss, not just process restarts.
    this.db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, time TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, time TEXT NOT NULL, run_id TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL);`);
    if (!this.get('bots')) this.set('bots', [
      { id: 'atlas', name: 'ATLAS / 01', asset: 'futures', symbol: 'MES', status: 'paused', strategy: 'Channel breakout v1', createdAt: new Date().toISOString(), description: 'Equity-index futures · paper research profile' },
      { id: 'orion', name: 'ORION / 02', asset: 'crypto', symbol: 'BTC-USD', status: 'paused', strategy: 'Channel breakout v1', createdAt: new Date().toISOString(), description: 'Bitcoin · spot paper research profile; derivatives deferred until venue selection' }
    ] satisfies Bot[]);
    if (this.get('halted') === null) this.set('halted', false);
  }
  get(key: string): any { const row = this.db.query('SELECT value FROM state WHERE key=?').get(key) as { value: string } | null; return row ? JSON.parse(row.value) : null; }
  set(key: string, value: unknown) { this.db.query('INSERT OR REPLACE INTO state VALUES (?,?)').run(key, JSON.stringify(value)); }
  audit(action: string, detail: string) { this.db.query('INSERT INTO audit (time,action,detail) VALUES (?,?,?)').run(new Date().toISOString(), action, detail); }
  command(id: string, action: string) {
    this.db.transaction(() => {
      const bots = this.get('bots') as Bot[], bot = bots.find(b => b.id === id);
      if (!bot || !['start', 'pause'].includes(action)) throw new Error('Unknown bot or action');
      if (action === 'start' && this.get('halted')) throw new Error('Emergency halt is latched. Reset explicitly before starting.');
      bot.status = action === 'start' ? 'running' : 'paused'; this.set('bots', bots); this.audit(action, id);
    })();
  }
  halt() { this.db.transaction(() => { this.set('halted', true); this.set('bots', (this.get('bots') as Bot[]).map(b => ({ ...b, status: 'halted' }))); this.audit('EMERGENCY_HALT', 'Paper exposure increases halted; positions remain open. External brokers are not controlled.'); })(); }
  reset() { this.db.transaction(() => { this.set('halted', false); this.set('bots', (this.get('bots') as Bot[]).map(b => ({ ...b, status: 'paused' }))); this.audit('RESET_HALT', 'Runners remain paused; explicit start required.'); })(); }
  saveRun(result: Result) { const id = crypto.randomUUID(); this.db.query('INSERT INTO runs VALUES (?,?,?)').run(id, new Date().toISOString(), JSON.stringify(result)); this.audit('BACKTEST', id); return id; }
  promote(id: string) {
    return this.db.transaction(() => {
      const run = this.db.query('SELECT result FROM runs WHERE id=?').get(id) as { result: string } | null;
      if (!run) throw new Error('Unknown run');
      const hash = new Bun.CryptoHasher('sha256').update(run.result).digest('hex');
      this.db.query('INSERT OR IGNORE INTO strategies VALUES (?,?,?,?,?)').run(crypto.randomUUID(), new Date().toISOString(), id, hash, 'paper-only / unvalidated');
      this.audit('REGISTER_STRATEGY', `${id}: paper-only, no live approval`); return hash;
    })();
  }
  snapshot() { return { bots: this.get('bots'), halted: this.get('halted'), mode: 'PAPER / SIMULATED', broker: 'NOT CONNECTED', audit: this.db.query('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all(), runs: this.db.query('SELECT id,time,result FROM runs ORDER BY time DESC LIMIT 30').all().map((r: any) => ({ ...r, result: JSON.parse(r.result) })), strategies: this.db.query('SELECT * FROM strategies ORDER BY time DESC').all() }; }
}