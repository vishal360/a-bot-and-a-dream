/** Opt-in upload/readback drill. Does not prune or alter the source. */
import { verifyBackup } from '../src/backup-verification';
import { rcloneReadbackVerifier } from '../src/rclone-verification';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: bun run scripts/verify-remote-backup.ts <backup-with-manifest> <remote:path>\nUploads to configured direct cloud backend, downloads to fresh temporary directory and compares bytes. No pruning, encryption or trading. Requires operator-configured rclone.');
  process.exit(0);
}
if (args.length !== 2 || args.some(v => v.startsWith('-'))) throw new Error('Expected backup file and explicit rclone remote:path; use --help');
const manifest = verifyBackup(args[0]);
const receipt = rcloneReadbackVerifier({ remote: args[1] })(args[0], manifest);
console.log(JSON.stringify({ receipt, sourceRetained: true, encryption: 'not-implemented', tradingEnabled: false }, null, 2));
