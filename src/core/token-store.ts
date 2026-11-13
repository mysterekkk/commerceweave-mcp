import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommerceError } from './errors.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  scope?: string;
}

/**
 * Persists OAuth tokens under COMMERCEWEAVE_HOME/tokens.
 * - With COMMERCEWEAVE_TOKEN_KEY set: AES-256-GCM (scrypt-derived key).
 * - Without: plaintext JSON, file mode 0600 (best effort on Windows). `encrypted` tells callers which.
 */
export class TokenStore {
  constructor(private readonly home: string, private readonly key?: string) {}

  get encrypted() {
    return !!this.key;
  }

  private file(id: string) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new CommerceError('CONFIG_INVALID', 'Invalid connection id for token storage');
    return join(this.home, 'tokens', `${id}.json`);
  }

  load(id: string): StoredTokens | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    const raw = JSON.parse(readFileSync(f, 'utf8')) as { v: number; enc?: boolean; salt?: string; iv?: string; tag?: string; data: string };
    if (!raw.enc) return JSON.parse(raw.data) as StoredTokens;
    if (!this.key) throw new CommerceError('CONFIG_INVALID', `Tokens for "${id}" are encrypted; set COMMERCEWEAVE_TOKEN_KEY`);
    try {
      const k = scryptSync(this.key, Buffer.from(raw.salt as string, 'base64'), 32);
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(raw.iv as string, 'base64'));
      d.setAuthTag(Buffer.from(raw.tag as string, 'base64'));
      const out = Buffer.concat([d.update(Buffer.from(raw.data, 'base64')), d.final()]);
      return JSON.parse(out.toString('utf8')) as StoredTokens;
    } catch {
      throw new CommerceError('CONFIG_INVALID', `Cannot decrypt tokens for "${id}" (wrong COMMERCEWEAVE_TOKEN_KEY?)`);
    }
  }

  save(id: string, t: StoredTokens) {
    const f = this.file(id);
    mkdirSync(join(this.home, 'tokens'), { recursive: true, mode: 0o700 });
    let payload: object;
    if (this.key) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', scryptSync(this.key, salt, 32), iv);
      const data = Buffer.concat([c.update(JSON.stringify(t), 'utf8'), c.final()]);
      payload = { v: 1, enc: true, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    } else {
      payload = { v: 1, enc: false, data: JSON.stringify(t) };
    }
    writeFileSync(f, JSON.stringify(payload), { mode: 0o600 });
    try {
      chmodSync(f, 0o600);
    } catch {
      /* not supported on this platform */
    }
  }
}
