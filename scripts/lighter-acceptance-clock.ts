import { acceptanceCriteria } from '../src/lighter-acceptance';

// A predeclared operational policy, not a UTC attestation or a trading permission.
export const clockPolicy = Object.freeze({ maximumSyncAgeSeconds: 3600,
  maximumUncertaintyMs: acceptanceCriteria.maximumClockDriftMs, recheckMs: 15 * 60 * 1000 });
export type ClockCommand = { exitCode: number | null; stdout: string; stderr: string };
export type ClockObservation = ReturnType<typeof evaluateWindowsClock> & { observedAt: string; observedMono: number; phase: 'starting' | 'observing' | 'finalizing' };

/** Unsupported/localized or incomplete output fails closed; never guess a time source. */
export function evaluateWindowsClock(platform: string, command: ClockCommand) {
  const failures: string[] = [];
  if (!command || typeof command.stdout !== 'string' || typeof command.stderr !== 'string' ||
      (command.exitCode !== null && !Number.isSafeInteger(command.exitCode))) failures.push('Malformed host-clock command evidence');
  const lines = typeof command?.stdout === 'string' ? command.stdout.split(/\r?\n/) : [];
  const field = (name: string) => {
    const matches = lines.filter(line => line.startsWith(`${name}:`));
    return matches.length === 1 ? matches[0].slice(name.length + 1).trim() : null;
  };
  const number = (name: string, seconds = false) => {
    const value = field(name), match = value?.match(seconds ? /^([+-]?\d+(?:\.\d+)?)s$/ : /^(\d+)(?:\s*\([^\r\n]*\))?$/);
    return match ? Number(match[1]) : null;
  };
  const leap = number('Leap Indicator'), stratum = number('Stratum'), source = field('Source');
  const syncAgeSeconds = number('Time since Last Good Sync Time', true), lastSyncError = number('Last Sync Error');
  const phaseOffsetSeconds = number('Phase Offset', true), rootDelaySeconds = number('Root Delay', true), rootDispersionSeconds = number('Root Dispersion', true);
  const uncertaintyMs = phaseOffsetSeconds === null || rootDelaySeconds === null || rootDispersionSeconds === null ? null :
    (Math.abs(phaseOffsetSeconds) + rootDelaySeconds / 2 + rootDispersionSeconds) * 1000;
  if (platform !== 'win32') failures.push('No supported host-clock verification backend for this platform');
  if (command?.exitCode !== 0) failures.push('Windows Time status query failed; synchronized host time is required');
  if (leap !== 0 || stratum === null || stratum < 1 || stratum > 15 || !Number.isInteger(stratum)) failures.push('Windows Time is not reporting a synchronized usable stratum');
  if (!source || /local|free.running|cmos|vm ic|hyper.v|unknown/i.test(source)) failures.push('External time source is missing or unverifiable');
  // Negative delay/dispersion is structurally impossible in NTP and always malformed evidence.
  if (rootDelaySeconds !== null && rootDelaySeconds < 0) failures.push('Negative root delay is malformed clock evidence');
  if (rootDispersionSeconds !== null && rootDispersionSeconds < 0) failures.push('Negative root dispersion is malformed clock evidence');
  // w32time keeps LastSyncError=2 until the next successful poll (1024-2048s). A stale
  // poll is tolerated only while the full error budget stays inside policy.
  const recentGoodStratum = stratum !== null && stratum >= 1 && stratum <= 4 && leap === 0;
  const staleIsTransient = lastSyncError === 2
    && syncAgeSeconds !== null && syncAgeSeconds >= 0 && syncAgeSeconds <= clockPolicy.maximumSyncAgeSeconds
    && recentGoodStratum
    && uncertaintyMs !== null && Number.isFinite(uncertaintyMs) && uncertaintyMs <= clockPolicy.maximumUncertaintyMs
    && rootDispersionSeconds !== null && rootDispersionSeconds < 1.0;
  if (staleIsTransient) {
    // single stale poll with an in-policy error budget - still anchored
  } else if (lastSyncError !== 0 || syncAgeSeconds === null || syncAgeSeconds < 0 || syncAgeSeconds > clockPolicy.maximumSyncAgeSeconds) failures.push('Recent successful Windows Time synchronization is not established');
  if (rootDelaySeconds === null || rootDispersionSeconds === null || uncertaintyMs === null || !Number.isFinite(uncertaintyMs) || uncertaintyMs > clockPolicy.maximumUncertaintyMs)
    failures.push('Reported clock uncertainty exceeds policy or is unavailable');
  return { version: 1, platform, command, policy: clockPolicy, source, leap, stratum, syncAgeSeconds,
    lastSyncError, phaseOffsetSeconds, rootDelaySeconds, rootDispersionSeconds, uncertaintyMs,
    passed: failures.length === 0, failures, utcCertified: false,
    scope: 'OS-reported synchronization only; not independent UTC certification', automationAuthorized: false, executionEnabled: false };
}

async function queryClock(): Promise<ClockCommand> {
  const child = Bun.spawn(['w32tm', '/query', '/status', '/verbose'], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** Read-only: never starts services, sets the clock, changes peers or resynchronizes. */
export async function observeHostClock(phase: ClockObservation['phase'], platform = process.platform,
  query: () => Promise<ClockCommand> = queryClock): Promise<ClockObservation> {
  let command: ClockCommand;
  try { command = platform === 'win32' ? await query() : { exitCode: null, stdout: '', stderr: 'Unsupported clock backend' }; }
  catch (e) { command = { exitCode: null, stdout: '', stderr: (e as Error).message }; }
  return { ...evaluateWindowsClock(platform, command), observedAt: new Date().toISOString(), observedMono: performance.now(), phase };
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error('No arguments accepted. This is a read-only host-clock check.');
  const result = await observeHostClock('starting');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}