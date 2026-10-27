/**
 * Read-only status of the current 24h acceptance run:  bun run scripts/scan-24h.ts [--json] [runId]
 * Reads data/acceptance/_active.json (written by scripts/run-24h.ps1) or the newest run directory.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastRun, formatDuration, type Heartbeat } from '../src/run-forecast';
import { observeHostClock } from './lighter-acceptance-clock';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'data', 'acceptance');
const args = process.argv.slice(2);
const json = args.includes('--json');
let runId = args.find(a => !a.startsWith('--')) ?? null;
if (!runId && existsSync(join(dir, '_active.json'))) runId = (await Bun.file(join(dir, '_active.json')).json()).runId ?? null;
if (!runId) runId = readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'run.json')))
  .sort((a, b) => statSync(join(dir, b, 'run.json')).mtimeMs - statSync(join(dir, a, 'run.json')).mtimeMs)[0] ?? null;
if (!runId || !existsSync(join(dir, runId, 'run.json'))) { console.error('No acceptance run found'); process.exit(2); }

const hb = await Bun.file(join(dir, runId, 'run.json')).json() as Heartbeat;
const report = existsSync(join(dir, runId, 'report.json')) ? await Bun.file(join(dir, runId, 'report.json')).json() : null;
let alive = false;
try { process.kill(hb.pid, 0); alive = true; } catch { alive = false; }
const clock = await observeHostClock('observing');
const f = forecastRun(hb, Date.now());
const out = { runId, alive, heartbeat: hb, forecast: f, clock: { passed: clock.passed, uncertaintyMs: clock.uncertaintyMs,
  rootDispersionSeconds: clock.rootDispersionSeconds, syncAgeSeconds: clock.syncAgeSeconds, lastSyncError: clock.lastSyncError,
  source: clock.source, stratum: clock.stratum, failures: clock.failures },
  report: report && { samplePassed: report.samplePassed, sustainedFeedAccepted: report.sustainedFeedAccepted,
    healthyFraction: report.healthyFraction, failures: report.failures } };
if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const local = (iso: string) => new Date(iso).toLocaleString();
const c = hb.counts;
console.log(`=== 24H SCAN ${new Date().toLocaleString()} ===`);
console.log(`Run        ${runId}  pid ${hb.pid} ${alive ? 'ALIVE' : 'NOT RUNNING'}  phase ${hb.phase}  state ${hb.state}`);
console.log(`Status     ${f.status}   healthy-now=${hb.healthy}   heartbeat ${Math.round(f.heartbeatAgeMs / 1000)}s ago`);
console.log(`Window     started ${local(hb.startedAt)}  ->  ETA ${local(f.etaIso)}`);
console.log(`Elapsed    ${formatDuration(f.elapsedMs)} / 24h (${pct(f.progress)})   remaining ${formatDuration(f.remainingMs)}`);
console.log(`Feed       frames ${c.frames}  accepted ${c.accepted} (${pct(c.frames ? c.accepted / c.frames : 0)})  trades ${c.tradeFrames}`);
console.log(`Churn      disconnects ${c.disconnects}/${f.maxDisconnects} budget  stale ${c.stale}  gaps ${c.gaps}  invalid ${c.invalid}  recordingFailures ${c.recordingFailures}`);
console.log(`Rate       ${f.ratePerHour.toFixed(2)}/h  -> projected ${Math.round(f.projectedDisconnects)} disconnects at 24h`);
console.log(`Health est ${pct(f.estimatedHealthyFraction)} (need >= 99.00%; ~${Math.round(f.estimatedUnhealthyMs / 1000)}s of ${f.budgetMs / 1000}s budget used)`);
console.log(`P(success) ${pct(f.feedProbability)}  feed-budget model only; excludes power cuts, clock aborts, single outages >30s`);
console.log(`Clock      ${clock.passed ? 'PASS' : 'FAIL'}  unc ${clock.uncertaintyMs?.toFixed(0)}ms  disp ${clock.rootDispersionSeconds}s  age ${clock.syncAgeSeconds?.toFixed(0)}s  err ${clock.lastSyncError}  ${clock.source}`);
if (clock.failures.length) console.log(`           ${clock.failures.join('; ')}`);
if (!alive && !hb.complete) console.log('WARNING    observer process is gone and no final report exists: this run is dead.');
if (report) console.log(`REPORT     samplePassed=${report.samplePassed} sustainedFeedAccepted=${report.sustainedFeedAccepted} healthy=${report.healthyFraction} failures=${JSON.stringify(report.failures)}`);
