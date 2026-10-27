import { acceptanceCriteria } from '../src/lighter-acceptance';

type Observer = {
  now: () => number;
  sample: () => number; // The monotonic timestamp actually recorded by acceptance.sample().
  sleep: (milliseconds: number) => Promise<void>;
  progress: (startedMono: number) => Promise<void>;
};

/** Heartbeat I/O cannot substitute for a sample at or beyond the requested duration. */
export async function observeAcceptance(durationMs: number, observer: Observer) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > acceptanceCriteria.sustainedMs) throw new Error('Invalid observation duration');
  const start = observer.sample();
  let latest = start;
  await observer.progress(start);
  let lastProgress = observer.now();
  while (latest - start < durationMs) {
    await observer.sleep(Math.min(1000, Math.max(1, durationMs - (observer.now() - start))));
    latest = observer.sample();
    if (latest - start >= durationMs) break;
    if (observer.now() - lastProgress >= 60000) {
      await observer.progress(start);
      lastProgress = observer.now();
    }
  }
}