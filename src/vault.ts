import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
export class Vault {
  private key: Buffer;
  constructor(path: string) {
    if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(path); if (this.key.length !== 32) throw new Error('Invalid vault key');
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
  encrypt(value: unknown) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv); const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64'); }
  decrypt(value: string): any { const b = Buffer.from(value, 'base64'), c = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString()); }
}