import { restoreCheck, verifyBackup } from '../src/backup-verification';

// Offline only. No remote claim, and no encryption of sensitive evidence is implemented.
const [source, flag, target] = Bun.argv.slice(2);
try {
  if (!source || (flag && (flag !== '--restore-to' || !target)) || Bun.argv.length > 5) throw new Error('Usage: bun scripts/verify-backup.ts <snapshot> [--restore-to <NEW-directory>]');
  const manifest = verifyBackup(source);
  console.log(JSON.stringify(target ? restoreCheck(source, target) : { ok: true, manifest, localVerified: true, remoteVerified: false, encryption: 'not-implemented' }, null, 2));
} catch (error) {
  console.error(`backup verification failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
