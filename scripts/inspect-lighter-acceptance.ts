import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acceptanceCriteria } from '../src/lighter-acceptance';
import { lighterStreamUrl } from '../src/lighter-stream';
import { replayCapture } from '../src/lighter-evidence';
import { acceptanceSourceFiles, readEvidenceFile } from './lighter-acceptance-evidence';
import { clockPolicy, evaluateWindowsClock } from './lighter-acceptance-clock';
import { lighterHosts } from '../src/lighter';

const safety = Object.freeze({ automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false });
// The stream orders captured markets by market_id while reports keep requested-symbol order:
// compare the exact market records as a set keyed by unique market_id, never by array position.
const marketSet = (markets: unknown) => {
  if (!Array.isArray(markets) || !markets.length || new Set(markets.map((m: any) => m?.market_id)).size !== markets.length ||
      markets.some((m: any) => !m || !Number.isSafeInteger(m.market_id))) return null;
  return JSON.stringify([...markets].sort((a: any, b: any) => a.market_id - b.market_id));
};

/** Disk evidence only: no process killing, live DB opens, Paper, credentials or readiness writes. */
export async function inspectAcceptance(directory: string) {
  try { return await inspectEvidence(directory); }
  catch (e) {
    return { ...safety, status: 'failed-or-unverifiable', complete: false, samplePassed: false, sustainedFeedAccepted: false,
      failures: [`Malformed or unreadable acceptance evidence: ${(e as Error).message}`], artifactChecks: [] };
  }
}

async function inspectEvidence(directory: string) {
  const failures: string[] = [], artifactChecks: { file: string; passed: boolean }[] = [];
  if (!existsSync(`${directory}/report.json`)) {
    const heartbeat = existsSync(`${directory}/run.json`) ? (await readEvidenceFile(directory, 'run.json')).record : null;
    return { ...safety, status: heartbeat ? 'pending-or-interrupted' : 'legacy-or-untracked', complete: false,
      samplePassed: false, sustainedFeedAccepted: false, heartbeat,
      failures: ['No final report; process existence or retained frames cannot establish acceptance'], artifactChecks };
  }
  const { record: report, hash } = await readEvidenceFile(directory, 'report.json');
  const run = existsSync(`${directory}/run.json`) ? (await readEvidenceFile(directory, 'run.json')).record : null;
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Invalid acceptance report object');
  if (!run || run.version !== 1 || run.complete !== true || run.phase !== 'completed' || run.reportFile !== 'report.json' || run.reportSha256 !== hash.sha256 ||
      !Number.isSafeInteger(report.pid) || report.pid < 1 || typeof report.startedAt !== 'string' || !Number.isFinite(Date.parse(report.startedAt)) ||
      typeof report.endedAt !== 'string' || !Number.isFinite(Date.parse(report.endedAt)) ||
      !Number.isSafeInteger(run.requestedSeconds) || run.requestedSeconds !== report.requestedSeconds ||
      run.pid !== report.pid || run.startedAt !== report.startedAt || run.requestedSeconds * 1000 !== report.requestedMs ||
      JSON.stringify(run.symbols) !== JSON.stringify(report.symbols) || run.samplePassed !== report.samplePassed ||
      run.sustainedFeedAccepted !== report.sustainedFeedAccepted || JSON.stringify(run.failures) !== JSON.stringify(report.failures)) failures.push('Completed heartbeat/report binding is missing or mismatched');
  for (const record of [run, report]) {
    if (!record || record.automationAuthorized !== false || record.executionEnabled !== false ||
        ['agentsEnabled', 'liveSigningEnabled', 'strategyValidated'].some(flag => record[flag] !== undefined && record[flag] !== false)) failures.push('Evidence safety flags are missing or inconsistent');
  }
  if (report.version !== 1 || report.source !== 'Lighter mainnet read-only' || JSON.stringify(report.criteria) !== JSON.stringify(acceptanceCriteria) ||
      report.metadataSource !== `${lighterHosts.mainnet}/api/v1/orderBookDetails` || report.metadataResolved !== true ||
      !Array.isArray(report.symbols) || report.symbols.length < 1 || report.symbols.length > 4 || new Set(report.symbols).size !== report.symbols.length ||
      report.symbols.some((s: any) => typeof s !== 'string' || s.length > 80 || !/^[A-Za-z0-9._/-]+$/.test(s)) ||
      report.sourcesStable !== true || !Array.isArray(report.sources) || report.sources.length !== acceptanceSourceFiles.length ||
      acceptanceSourceFiles.some(file => report.sources.filter((s: any) => s?.file === file && Number.isSafeInteger(s.bytes) && s.bytes > 0 && /^[a-f0-9]{64}$/.test(s.sha256)).length !== 1)) failures.push('Exact observer source provenance is missing or invalid');
  // Do not compare with today's source: an older completed run may legitimately use a frozen version.
  if (!Array.isArray(report.clocks) || report.clocks.length < 2 || report.clocks.length > 110 ||
      report.clocks[0]?.phase !== 'starting' || report.clocks.at(-1)?.phase !== 'finalizing' ||
      report.clocks.some((c: any, i: number) => !c || c.passed !== true || c.utcCertified !== false || !Number.isFinite(Date.parse(c.observedAt)) ||
        c.version !== 1 || c.automationAuthorized !== false || c.executionEnabled !== false || JSON.stringify(c.policy) !== JSON.stringify(clockPolicy) ||
        typeof c.observedAt !== 'string' || !Number.isFinite(c.observedMono) || c.observedMono < 0 ||
        (i > 0 && i < report.clocks.length - 1 && c.phase !== 'observing') ||
        (i > 0 && (c.observedMono < report.clocks[i - 1].observedMono || c.observedMono - report.clocks[i - 1].observedMono > clockPolicy.recheckMs + 75000)) ||
        Math.abs((Date.parse(c.observedAt) - Date.parse(report.clocks[0].observedAt)) - (c.observedMono - report.clocks[0].observedMono)) > acceptanceCriteria.maximumClockDriftMs ||
        !evaluateWindowsClock(c.platform, c.command ?? { exitCode: null, stdout: '', stderr: '' }).passed)) failures.push('Required start/end host-clock evidence is incomplete or failed');
  const observation = report.observation;
  if (!observation || !Number.isFinite(observation.startedMono) || observation.startedMono < 0 || !Number.isFinite(observation.endedMono) ||
      observation.endedMono < observation.startedMono || Math.abs(observation.endedMono - observation.startedMono - report.elapsedMs) > 0.001 ||
      !Array.isArray(report.clocks) || observation.startedMono < report.clocks[0]?.observedMono || observation.endedMono > report.clocks.at(-1)?.observedMono ||
      Date.parse(report.endedAt) - Date.parse(report.startedAt) + acceptanceCriteria.maximumClockDriftMs < report.elapsedMs) failures.push('Host-clock checks do not cover the recorded sample window');
  const captures = Array.isArray(report.captures) ? report.captures : [], artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
  if (!captures.length || captures.length > 4 || artifacts.length < 2 || artifacts.length > 5 ||
      new Set(artifacts.map((a: any) => a?.file)).size !== artifacts.length ||
      artifacts.length !== captures.filter((c: any) => !c.error).length + 1 ||
      artifacts.filter((a: any) => a?.file === 'metadata.json').length !== 1) failures.push('Bounded metadata/capture artifact manifest is incomplete');
  for (const artifact of artifacts.slice(0, 5)) {
    try {
      const { record, hash: actual } = await readEvidenceFile(directory, artifact.file);
      if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) throw new Error('Artifact checksum mismatch');
      if (artifact.file === 'metadata.json') {
        if (record.code !== 200 || !Array.isArray(record.order_book_details) || !Array.isArray(report.metadata) || !report.metadata.length || report.metadata.length > 4 ||
            JSON.stringify(report.metadata.map((m: any) => m.symbol)) !== JSON.stringify(report.symbols) ||
            report.metadata.some((m: any) => record.order_book_details.filter((row: any) => row.symbol === m.symbol && row.status === 'active' && row.market_type === 'perp' &&
              row.market_id === m.market_id && row.supported_price_decimals === m.supported_price_decimals && row.supported_size_decimals === m.supported_size_decimals).length !== 1)) throw new Error('Metadata identity mismatch');
      } else {
        const check = captures.find((c: any) => `${c.id}.json` === artifact.file), replay = replayCapture(record);
        if (!check || check.error || record.manifest.id !== check.id || record.manifest.source !== lighterStreamUrl || record.manifest.marketStats !== true ||
            record.manifest.staleMs !== 5000 || !marketSet(record.manifest.markets) || marketSet(record.manifest.markets) !== marketSet(report.metadata) ||
            replay.stateSha256 !== check.stateSha256 || replay.frames !== check.frames || !replay.snapshotRooted || !replay.statsCovered) throw new Error('Capture replay mismatch');
      }
      artifactChecks.push({ file: artifact.file, passed: true });
    } catch (e) { failures.push(`${artifact?.file ?? 'Invalid artifact'}: ${(e as Error).message}`); artifactChecks.push({ file: artifact?.file, passed: false }); }
  }
  if (report.samplePassed !== true || !Array.isArray(report.failures) || report.failures.length !== 0 ||
      !Number.isSafeInteger(report.requestedMs) || report.requestedMs < 60000 || report.requestedMs > acceptanceCriteria.sustainedMs ||
      !Number.isFinite(report.elapsedMs) || report.elapsedMs < report.requestedMs || !Number.isSafeInteger(report.samples) || report.samples < 2 ||
      report.elapsedMs > (report.samples - 1) * report.maximumSampleGapMs + 0.001 ||
      !Number.isFinite(report.healthyFraction) || report.healthyFraction < acceptanceCriteria.minimumHealthyFraction || report.healthyFraction > 1 ||
      !Number.isFinite(report.healthyMs) || !Number.isFinite(report.unhealthyMs) || report.healthyMs < 0 || report.unhealthyMs < 0 ||
      Math.abs(report.healthyMs + report.unhealthyMs - report.elapsedMs) > 0.001 ||
      Math.abs(report.healthyMs / report.elapsedMs - report.healthyFraction) > 1e-9 ||
      !Number.isFinite(report.longestUnhealthyMs) || report.longestUnhealthyMs > acceptanceCriteria.maximumUnhealthyMs || report.longestUnhealthyMs < 0 ||
      report.longestUnhealthyMs > report.unhealthyMs + 0.001 || report.maximumSampleGapMs > report.elapsedMs ||
      !Number.isFinite(report.maximumSampleGapMs) || report.maximumSampleGapMs > acceptanceCriteria.maximumSampleGapMs || report.maximumSampleGapMs < 0 ||
      !Number.isFinite(report.maximumClockDriftMs) || report.maximumClockDriftMs > acceptanceCriteria.maximumClockDriftMs || report.maximumClockDriftMs < 0 ||
      report.recordingFailures !== 0 || !Number.isSafeInteger(report.acceptedFrames) || report.acceptedFrames < 1 ||
      !Number.isSafeInteger(report.tradeFrames) || report.tradeFrames < 1 || report.tradeFrames > report.acceptedFrames ||
      captures.some((c: any) => !c || c.error !== null || !c.snapshotRooted || !c.statsCovered || !Number.isSafeInteger(c.frames) || c.frames < 1 ||
        artifacts.filter((a: any) => a?.file === `${c.id}.json`).length !== 1) ||
      report.tradeContinuity !== 'unproven' || report.strategyValidated !== false ||
      !Array.isArray(report.markets) || report.markets.length !== report.symbols?.length ||
      new Set(report.markets.map((m: any) => m.marketId)).size !== report.markets.length ||
      report.markets.some((m: any) => !Number.isSafeInteger(m.marketId) || m.marketId < 0 || m.tradesObserved !== true) ||
      JSON.stringify(report.markets?.map((m: any) => m.marketId)) !== JSON.stringify(report.metadata?.map((m: any) => m.market_id))) failures.push('Observation did not meet unchanged feed criteria');
  const sustained = report.samplePassed === true && report.requestedMs === acceptanceCriteria.sustainedMs && report.elapsedMs >= acceptanceCriteria.sustainedMs;
  if (report.sustainedFeedAccepted !== sustained) failures.push('Sustained-feed result is inconsistent with duration');
  const passed = failures.length === 0;
  return { ...safety, status: passed ? 'verified-completed' : 'failed-or-unverifiable', complete: run?.complete === true,
    samplePassed: passed, sustainedFeedAccepted: passed && sustained, pid: report.pid, reportSha256: hash.sha256,
    sources: report.sources, failures, artifactChecks,
    scope: 'Local hash/replay and OS clock checks; not complete trade continuity, UTC certification, strategy validation or trading authority' };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: bun run scripts/inspect-lighter-acceptance.ts <run-uuid>\nRead-only inspection under data/acceptance. No final report means no acceptance; legacy evidence is never upgraded.');
  else {
    if (args.length !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args[0])) throw new Error('One acceptance run UUID required; use --help');
    const result = await inspectAcceptance(fileURLToPath(new URL(`../data/acceptance/${args[0]}/`, import.meta.url)));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.samplePassed ? 0 : 1;
  }
}