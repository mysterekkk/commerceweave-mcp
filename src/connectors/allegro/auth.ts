import type { AllegroConfig } from '../../core/config.js';
import { CommerceError } from '../../core/errors.js';
import type { StoredTokens, TokenStore } from '../../core/token-store.js';

export function allegroHosts(cfg: Pick<AllegroConfig, 'environment' | 'apiUrl' | 'authUrl'>) {
  const sandbox = cfg.environment === 'sandbox';
  return {
    api: cfg.apiUrl ?? (sandbox ? 'https://api.allegro.pl.allegrosandbox.pl' : 'https://api.allegro.pl'),
    auth: cfg.authUrl ?? (sandbox ? 'https://allegro.pl.allegrosandbox.pl' : 'https://allegro.pl'),
  };
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; scope?: string }

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export class AllegroAuth {
  private refreshing?: Promise<StoredTokens>;
  private readonly hosts: ReturnType<typeof allegroHosts>;

  constructor(private readonly cfg: AllegroConfig, private readonly store: TokenStore, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.hosts = allegroHosts(cfg);
  }

  private basic() {
    return 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
  }

  private async tokenCall(path: string, form: Record<string, string>): Promise<Response> {
    return fetch(`${this.hosts.auth}${path}`, {
      method: 'POST',
      headers: { Authorization: this.basic(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  }

  /** Device flow step 1: returns the code the user must enter on the Allegro page. */
  async startDeviceFlow(): Promise<DeviceCode> {
    const res = await this.tokenCall('/auth/oauth/device', { client_id: this.cfg.clientId });
    if (!res.ok) throw new CommerceError('AUTH_FAILED', `Allegro device authorization failed (${res.status}). Check client id/secret and that the application allows the device flow.`, { connectionId: this.cfg.id, status: res.status });
    return (await res.json()) as DeviceCode;
  }

  /** Device flow step 2: poll until the user has approved (or the code expired). */
  async completeDeviceFlow(code: DeviceCode): Promise<StoredTokens> {
    const deadline = Date.now() + code.expires_in * 1000;
    let interval = Math.max(code.interval, 1) * 1000;
    while (Date.now() < deadline) {
      await this.sleep(interval);
      const res = await this.tokenCall('/auth/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code });
      const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
      if (res.ok && body.access_token) return this.persist(body as TokenResponse);
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') { interval += 5000; continue; }
      throw new CommerceError('AUTH_FAILED', `Allegro authorization failed: ${body.error ?? res.status}`, { connectionId: this.cfg.id });
    }
    throw new CommerceError('AUTH_FAILED', 'Allegro device code expired before it was approved. Run setup again.', { connectionId: this.cfg.id });
  }

  private persist(r: TokenResponse): StoredTokens {
    const t: StoredTokens = { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: Date.now() + r.expires_in * 1000, scope: r.scope };
    this.store.save(this.cfg.id, t);
    return t;
  }

  hasTokens(): boolean {
    return !!this.store.load(this.cfg.id);
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const t = this.store.load(this.cfg.id);
    if (!t) throw new CommerceError('AUTH_FAILED', `Allegro connection "${this.cfg.id}" is not authorized yet. Run: commerceweave-mcp setup allegro`, { connectionId: this.cfg.id, hint: 'setup allegro' });
    if (!forceRefresh && t.expiresAt - Date.now() > 60_000) return t.accessToken;
    this.refreshing ??= this.refresh(t).finally(() => { this.refreshing = undefined; });
    return (await this.refreshing).accessToken;
  }

  private async refresh(t: StoredTokens): Promise<StoredTokens> {
    const res = await this.tokenCall('/auth/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refreshToken });
    const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
    if (!res.ok || !body.access_token) {
      throw new CommerceError('AUTH_FAILED', `Allegro token refresh failed (${body.error ?? res.status}). The refresh token may have expired or been revoked; run: commerceweave-mcp setup allegro`, { connectionId: this.cfg.id, status: res.status, hint: 'setup allegro' });
    }
    // Allegro rotates refresh tokens: always store the new one.
    return this.persist(body as TokenResponse);
  }
}
