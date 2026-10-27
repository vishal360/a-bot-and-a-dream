import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAcceptance } from './inspect-lighter-acceptance';
import { hashAcceptanceSources, readEvidenceFile, sha256, type EvidenceHash } from './lighter-acceptance-evidence';
import { observeHostClock, evaluateWindowsClock, type ClockObservation } from './lighter-acceptance-clock';
import { currentReviewSources, verifyReviewBundle } from './lighter-review-bundle';

const safety = Object.freeze({ automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bundleId = /^review-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type InspectedRun = { id: string; inspection: { status: string; complete: boolean; samplePassed: boolean; sustainedFeedAccepted: boolean;
  automationAuthorized: boolean; agentsEnabled: boolean; executionEnabled: boolean; liveSigningEnabled: boolean;
  reportSha256?: string; failures: string[]; artifactChecks: { file: string; passed: boolean }[] }; report: any };
const canonicalSources = (sources: EvidenceHash[]) => JSON.stringify([...sources].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

/** Aggregation policy only. Callers must first obtain inspection results from exact disk bytes. */
export function evaluateObservationPair(short: InspectedRun | null, sustained: InspectedRun | null, sources: EvidenceHash[]) {
  try { return evaluatePair(short, sustained, sources); }
  catch (e) { return { passed: false, failures: [`Malformed observation pair: ${(e as Error).message}`] }; }
}

function evaluatePair(short: InspectedRun | null, sustained: InspectedRun | null, sources: EvidenceHash[]) {
  const failures: string[] = [];
  for (const [label, run, seconds] of [['short', short, 60], ['sustained', sustained, 86400]] as const) {
    if (!run) { failures.push(`Missing separate ${label} observation`); continue; }
    const { report, inspection } = run;
    if (!uuid.test(run.id) || inspection.status !== 'verified-completed' || inspection.complete !== true || inspection.samplePassed !== true ||
        report?.requestedSeconds !== seconds || report.requestedMs !== seconds * 1000 ||
        inspection.sustainedFeedAccepted !== (seconds === 86400) ||
        !Array.isArray(report.sources) || canonicalSources(report.sources) !== canonicalSources(sources))
      failures.push(`${label} observation is incomplete, failed, wrong-duration or not on current observer sources`);
    if (Object.keys(safety).some(key => (inspection as any)[key] !== false) || report?.automationAuthorized !== false || report?.executionEnabled !== false ||
        ['agentsEnabled', 'liveSigningEnabled', 'strategyValidated'].some(key => report?.[key] !== undefined && report[key] !== false))
      failures.push(`${label} observation has inconsistent authority flags`);
    if (!Number.isFinite(Date.parse(report?.startedAt)) || !Number.isFinite(Date.parse(report?.endedAt)) || Date.parse(report?.endedAt) < Date.parse(report?.startedAt))
      failures.push(`${label} observation has invalid run timestamps`);
  }
  if (short && sustained) {
    if (short.id === sustained.id || short.inspection.reportSha256 === sustained.inspection.reportSha256) failures.push('Short and sustained evidence must be separate runs');
    if (Date.parse(short.report?.endedAt) > Date.parse(sustained.report?.startedAt)) failures.push('Sustained observation must start after the completed short observation');
    const markets = (report: any) => {
      if (!Array.isArray(report?.metadata) || report.metadata.length < 1 || !Array.isArray(report.symbols) || report.metadata.length !== report.symbols.length) return null;
      return JSON.stringify(report.metadata.map((m: any) => ({ symbol: m.symbol, marketId: m.market_id,
        priceDecimals: m.supported_price_decimals, sizeDecimals: m.supported_size_decimals })).sort((a: any, b: any) => a.marketId - b.marketId));
    };
    if (!markets(short.report) || markets(short.report) !== markets(sustained.report)) failures.push('Short and sustained market identities/precision must match');
  }
  return { passed: failures.length === 0, failures };
}

/** Local evidence + one read-only clock query. Never starts observers, repairs services or opens the operator DB. */
export async function inspectFoundationGate(root: string, options: { bundle?: string; short?: string; sustained?: string },
  clockQuery: () => Promise<ClockObservation> = () => observeHostClock('starting')) {
  const failures: string[] = [];
  let review: Awaited<ReturnType<typeof verifyReviewBundle>> | null = null;
  let clock: ClockObservation | null = null;
  let short: InspectedRun | null = null, sustained: InspectedRun | null = null;
  let currentFingerprint: string | null = null, observerFingerprint: string | null = null;
  let pair: ReturnType<typeof evaluateObservationPair> = { passed: false, failures: ['Observations not evaluated'] };
  try {
    for (const [key, value] of Object.entries(options)) {
      if (!['bundle', 'short', 'sustained'].includes(key) || value !== undefined && !(key === 'bundle' ? bundleId : uuid).test(value)) throw new Error(`Invalid gate option: ${key}`);
    }
    const initial = await currentReviewSources(root);
    currentFingerprint = initial.fingerprint;
    const sources = await hashAcceptanceSources(root);
    observerFingerprint = sha256(canonicalSources(sources));
    if (options.bundle) {
      review = await verifyReviewBundle(resolve(root, 'data/resumption/acceptance-hardening/packages', options.bundle), root);
      if (!review.passed) failures.push(...review.failures.map(failure => `Software review: ${failure}`));
    } else failures.push('Missing current independently verified software review bundle');
    clock = await clockQuery();
    if (clock.passed !== true || clock.utcCertified !== false || !evaluateWindowsClock(clock.platform, clock.command).passed ||
        clock.automationAuthorized !== false || clock.executionEnabled !== false) failures.push('Current host-clock preflight failed; administrator-approved repair remains required');
    const readRun = async (id: string): Promise<InspectedRun> => {
      const directory = resolve(root, 'data/acceptance', id);
      const inspection = await inspectAcceptance(directory);
      // Bind the aggregate's metadata/source comparison to the bytes the inspector verified.
      let report: any = null;
      if (inspection.status === 'verified-completed') {
        const evidence = await readEvidenceFile(directory, 'report.json');
        if (!('reportSha256' in inspection) || evidence.hash.sha256 !== inspection.reportSha256) throw new Error('Report changed between inspection and aggregation');
        report = evidence.record;
      }
      return { id, inspection, report };
    };
    if (options.short) short = await readRun(options.short);
    if (options.sustained) sustained = await readRun(options.sustained);
    pair = evaluateObservationPair(short, sustained, sources);
    failures.push(...pair.failures);
    if ((await currentReviewSources(root)).fingerprint !== initial.fingerprint) failures.push('Sources changed during foundation inspection');
  } catch (e) { failures.push(`Foundation evidence unavailable: ${(e as Error).message}`); }
  return { version: 1, ...safety, foundationEvidencePassed: failures.length === 0,
    currentFingerprint, observerFingerprint, review, clock, observations: {
      short: short ? { id: short.id, ...short.inspection } : null,
      sustained: sustained ? { id: sustained.id, ...sustained.inspection } : null, pair }, failures,
    remainingGates: [
      'Recorded genuine runtime recovery/disconnect/restore/storage evidence; fixture drills do not substitute',
      'Funding eligibility/ordering, rounding/discounts, revision policy and overnight UTC/account reconciliation',
      'Frozen strategy/risk artifact, provenance-verified data, leakage controls, untouched holdout and walk-forward evaluation',
      'Isolated shadow-only proposals without trading-state/key access, followed by measured paper-forward evidence',
      'Explicit bounded paper promotion through the existing central risk/reservation/executor; no alternate order path',
      'Separate live eligibility, signer/adapter/reconciliation, operations and capital authorization',
    ], scope: 'Read-only foundation evidence only; not runtime-recovery acceptance, strategy approval, profitability, UTC attestation or trading authorization' };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: bun run scripts/lighter-foundation-gate.ts [--bundle review-<uuid>] [--short <uuid>] [--sustained <uuid>]\nRead-only evidence gate. Missing/failed evidence exits 1. Queries clock; does not start observers, change services or enable trading.');
  else {
    const options: { bundle?: string; short?: string; sustained?: string } = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !['bundle', 'short', 'sustained'].includes(key) || Object.hasOwn(options, key) || !args[i + 1]) throw new Error('Invalid or duplicate gate argument; use --help');
      (options as Record<string, string>)[key] = args[i + 1];
    }
    const result = await inspectFoundationGate(fileURLToPath(new URL('../', import.meta.url)), options);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.foundationEvidencePassed ? 0 : 1;
  }
}