import { resolve } from 'node:path';
import { replayCapture } from '../src/lighter-evidence';

const input = process.argv[2];
if (!input) throw new Error('Usage: bun run scripts/replay-lighter.ts <exported-capture.json>');
const file = Bun.file(resolve(input));
if (file.size > 16 * 1024 * 1024) throw new Error('Replay export exceeds 16 MiB');
console.log(JSON.stringify(replayCapture(await file.json()), null, 2));