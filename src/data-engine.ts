/** Durable data engine (docs/DATA_ENGINE.md).
 *
 *  The live feed records bounded captures into a small evidence ring (4 captures,
 *  2000 frames each) and evicts everything older forever: before this engine,
 *  recorded market depth was lost as soon as four captures rolled. The engine
 *  continuously exports terminal captures ('closed' | 'limited' | 'interrupted')
 *  into data/archive/<UTC-day>/<startedMs>-<captureId>.json — the exact
 *  ReplayCapture JSON the replay engine and research pipeline already consume —
 *  keeps an append-only JSONL index, and prunes the archive under operator
 *  retention limits (keepDays / keepBytes).
 *
 *  Integrity and honesty: the engine verifies the archive round-trip by
 *  recomputing the capture checksum before writing and records the value in the
 *  index; SEMANTIC validation (frame order, book replay) happens at replay time
 *  in replayCapture — the archive never vouches for edge content, only for
 *  "these are the bytes the recorder saw". Failures are audited and surfaced in
 *  status(); the engine never blocks or touches the feed's recording path. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LighterEvidence } from './lighter-evidence';
import type { Store } from './store';

export type DataEngineOptions = { root?: string; keepDays?: number; keepBytes?: number; pollMs?: number };
export type ArchiveRecord = {
  captureId: string; file: string; sha256: string; markets: string[]; startedMs: number;
  endedMs: number | null; state: string; frames: number; sourceBytes: number; archiveBytes: number; archivedAt: string;
};

const indexName = 'index.jsonl';

export class DataEngine {
  private root: string;
  private keepDays: number;
  private keepBytes: number;
  private pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = new Map<string, ArchiveRecord>();
  private failures: string[] = [];
  private lastArchivedAt: string | null = null;
  private busy = false;

  constructor(private store: Store, private evidence: LighterEvidence, options: DataEngineOptions = {}) {
    this.root = resolve(options.root ?? 'data/archive');
    this.keepDays = options.keepDays ?? 30;
    this.keepBytes = options.keepBytes ?? 2 * 1024 * 1024 * 1024;
    this.pollMs = options.pollMs ?? 10000;
    if (!Number.isInteger(this.keepDays) || this.keepDays < 1) throw new Error('Invalid archive keepDays');
    if (!Number.isSafeInteger(this.keepBytes) || this.keepBytes < 4096) throw new Error('Invalid archive keepBytes');
    if (!Number.isInteger(this.pollMs) || this.pollMs < 250) throw new Error('Invalid archive pollMs');
    mkdirSync(this.root, { recursive: true });
    this.loadIndex();
  }

  private indexFile() { return join(this.root, indexName); }

  private loadIndex() {
    this.index.clear();
    if (!existsSync(this.indexFile())) return;
    for (const line of readFileSync(this.indexFile(), 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line) as ArchiveRecord;
        if (!record || typeof record.captureId !== 'string' || typeof record.file !== 'string' || typeof record.sha256 !== 'string') throw new Error('bad record');
        this.index.set(record.captureId, record);
      } catch {
        this.failures.push('index line unreadable and skipped');
      }
    }
  }

  private persistIndex() {
    const tmp = `${this.indexFile()}.tmp`;
    writeFileSync(tmp, [...this.index.values()].map(record => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8' });
    renameSync(tmp, this.indexFile());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { this.fail(`tick failed: ${(error as Error).message}`); }
    }, this.pollMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One archive cycle: export every unarchived terminal capture, then enforce retention. */
  tick(): { archived: string[]; pruned: string[] } {
    if (this.busy) return { archived: [], pruned: [] };
    this.busy = true;
    try {
      const archived = this.archiveNew();
      const pruned = this.enforceRetention();
      if (archived.length) this.lastArchivedAt = new Date().toISOString();
      return { archived, pruned };
    } finally { this.busy = false; }
  }

  private archiveNew(): string[] {
    const archived: string[] = [];
    for (const manifest of this.evidence.list()) {
      if (manifest.state === 'capturing' || this.index.has(manifest.id)) continue;
      try {
        const capture = this.evidence.export(manifest.id);
        const recompute = new Bun.CryptoHasher('sha256').update(JSON.stringify({ manifest: capture.manifest, frames: capture.frames })).digest('hex');
        if (recompute !== capture.sha256) throw new Error(`round-trip checksum mismatch (${recompute.slice(0, 12)} vs ${capture.sha256.slice(0, 12)})`);
        const day = new Date(capture.manifest.startedMs).toISOString().slice(0, 10);
        const file = join(this.root, day, `${capture.manifest.startedMs}-${capture.manifest.id.replace(/[^A-Za-z0-9-]/g, '-')}.json`);
        mkdirSync(dirname(file), { recursive: true });
        const bytes = Buffer.from(JSON.stringify(capture), 'utf8');
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, file);
        const record: ArchiveRecord = {
          captureId: capture.manifest.id, file, sha256: capture.sha256,
          markets: capture.manifest.markets.map(m => m.symbol), startedMs: capture.manifest.startedMs,
          endedMs: capture.manifest.endedMs, state: capture.manifest.state, frames: capture.manifest.frames,
          sourceBytes: capture.manifest.bytes, archiveBytes: bytes.byteLength, archivedAt: new Date().toISOString(),
        };
        this.index.set(record.captureId, record);
        this.persistIndex();
        this.store.audit('DATA_ARCHIVE_CAPTURE', `${record.captureId}: ${record.frames} frames, ${record.markets.join('/')} -> ${record.file}`);
        archived.push(record.captureId);
      } catch (error) {
        this.fail(`archive ${manifest.id}: ${(error as Error).message}`);
      }
    }
    return archived;
  }

  private enforceRetention(): string[] {
    const pruned: string[] = [];
    const cutoff = Date.now() - this.keepDays * 86400000;
    let total = 0;
    for (const record of this.index.values()) total += record.archiveBytes;
    for (const record of [...this.index.values()].sort((a, b) => a.startedMs - b.startedMs)) {
      if (record.startedMs >= cutoff && total <= this.keepBytes) break;
      if (record.startedMs < cutoff || total > this.keepBytes) {
        try {
          if (existsSync(record.file)) rmSync(record.file);
          total -= record.archiveBytes;
          this.index.delete(record.captureId);
          pruned.push(record.captureId);
        } catch (error) {
          this.fail(`prune ${record.captureId}: ${(error as Error).message}`);
        }
      }
    }
    if (pruned.length) this.persistIndex();
    return pruned;
  }

  private report() { while (this.failures.length > 10) this.failures.shift(); }
  private fail(message: string) {
    this.failures.push(message);
    this.report();
    this.store.audit('DATA_ARCHIVE_FAILURE', message);
  }

  status() {
    let bytesOnDisk = 0;
    for (const record of this.index.values()) bytesOnDisk += record.archiveBytes;
    return {
      root: this.root, captures: this.index.size, bytesOnDisk, keepDays: this.keepDays, keepBytes: this.keepBytes,
      lastArchivedAt: this.lastArchivedAt, failures: this.failures.slice(-5),
      ring: this.evidence.list().map(m => ({ id: m.id, state: m.state, frames: m.frames, markets: m.markets.map(x => x.symbol) })),
    };
  }
}
