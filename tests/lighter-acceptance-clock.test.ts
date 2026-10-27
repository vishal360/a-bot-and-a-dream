import { test, expect } from 'bun:test';
import { evaluateWindowsClock, observeHostClock } from '../scripts/lighter-acceptance-clock';

const status = [
  'Leap Indicator: 0(no warning)', 'Stratum: 2 (secondary reference - syncd by (S)NTP)',
  'Source: time.windows.com,0x9', 'Time since Last Good Sync Time: 30.1000000s',
  'Last Sync Error: 0 (The command completed successfully.)', 'Phase Offset: -0.0010000s',
  'Root Delay: 0.0200000s', 'Root Dispersion: 0.0300000s',
].join('\r\n');
const command = { exitCode: 0, stdout: status, stderr: '' };

test('recent external OS synchronization passes only the operational clock policy, never authority', () => {
  const result = evaluateWindowsClock('win32', command);
  expect(result).toMatchObject({ passed: true, source: 'time.windows.com,0x9',
    syncAgeSeconds: 30.1, utcCertified: false, automationAuthorized: false, executionEnabled: false });
  expect(result.uncertaintyMs).toBeCloseTo(41, 8);
});

test('clock failures, local sources, stale synchronization and uncertainty fail closed', () => {
  for (const [before, after] of [
    ['Leap Indicator: 0', 'Leap Indicator: 3'], ['Stratum: 2', 'Stratum: 16'], ['Stratum: 2', 'Stratum: 2.5'],
    ['time.windows.com,0x9', 'Local CMOS Clock'], ['time.windows.com,0x9', 'VM IC Time Synchronization Provider'],
    ['30.1000000s', '3600.0001s'], ['30.1000000s', '-1s'], ['Last Sync Error: 0', 'Last Sync Error: 1'],
    ['-0.0010000s', '-2.001s'], ['Root Dispersion: 0.0300000s', 'Root Dispersion: 3s'],
    ['Root Delay: 0.0200000s', 'Root Delay: -1s'], ['Source:', 'Localized source:'],
  ]) expect(evaluateWindowsClock('win32', { ...command, stdout: status.replace(before, after) }).passed).toBe(false);
  for (const stdout of ['', 'The service has not been started. (0x80070426)', status.replace('Root Delay: 0.0200000s', '')])
    expect(evaluateWindowsClock('win32', { ...command, stdout }).passed).toBe(false);
  expect(evaluateWindowsClock('linux', command).passed).toBe(false);
  expect(evaluateWindowsClock('win32', { ...command, exitCode: 1 }).passed).toBe(false);
});

test('clock policy boundaries are inclusive and incomplete/malformed seconds are never inferred', () => {
  expect(evaluateWindowsClock('win32', { ...command, stdout: status.replace('30.1000000s', '3600s') }).passed).toBe(true);
  for (const value of ['NaNs', 'Infinitys', '1ms', '1s trailing text', '1,2s'])
    expect(evaluateWindowsClock('win32', { ...command, stdout: status.replace('30.1000000s', value) }).passed).toBe(false);
});

test('duplicate status fields and malformed command records fail closed without throwing', () => {
  for (const field of status.split('\r\n'))
    expect(evaluateWindowsClock('win32', { ...command, stdout: `${status}\r\n${field}` }).passed).toBe(false);
  for (const malformed of [null, {}, { ...command, stdout: 42 }, { ...command, stderr: null }, { ...command, exitCode: '0' }])
    expect(evaluateWindowsClock('win32', malformed as any).passed).toBe(false);
});

test('clock observation captures command errors and never invokes a backend on unsupported hosts', async () => {
  let queries = 0;
  const query = async () => { queries++; return command; };
  expect((await observeHostClock('starting', 'win32', query)).passed).toBe(true);
  expect((await observeHostClock('finalizing', 'linux', query)).passed).toBe(false);
  expect(queries).toBe(1);
  const failed = await observeHostClock('observing', 'win32', async () => { throw new Error('query failed'); });
  expect(failed.passed).toBe(false); expect(failed.command.stderr).toBe('query failed');
});

test('clock backend uses only the bounded read-only status command', async () => {
  const text = await Bun.file(new URL('../scripts/lighter-acceptance-clock.ts', import.meta.url)).text();
  expect(text).toContain("['w32tm', '/query', '/status', '/verbose']");
  for (const forbidden of ['Start-Service', '/resync', '/config', '/register', 'Set-Date']) expect(text).not.toContain(forbidden);
});