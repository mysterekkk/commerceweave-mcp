import { createInterface } from 'node:readline/promises';
import { AllegroConnector } from '../connectors/allegro/index.js';
import { buildRegistry } from '../connectors/registry.js';
import { ApprovalStore, confirmCode } from '../core/approvals.js';
import { loadSettings, type Settings } from '../core/config.js';
import { safeDisplay as sd } from '../core/display.js';
import { toCommerceError } from '../core/errors.js';
import { TokenStore } from '../core/token-store.js';
import { SERVER_VERSION } from '../server/create-server.js';

const out = (s = '') => process.stdout.write(s + '\n');

export const HELP = `commerceweave-mcp ${SERVER_VERSION} — one MCP server, three commerce platforms

Usage:
  commerceweave-mcp                    Start the MCP server on stdio (what MCP clients run)
  commerceweave-mcp serve-http         Start the Streamable HTTP server (needs COMMERCEWEAVE_HTTP_TOKEN; loopback only by default)
  commerceweave-mcp doctor             Check configuration and connectivity (never prints secrets)
  commerceweave-mcp check              Validate configuration only (no network)
  commerceweave-mcp list-connections   Show configured connections
  commerceweave-mcp test-connection <id>   Make one read-only call to a connection
  commerceweave-mcp setup allegro [id]     Authorize Allegro via the OAuth2 device flow
  commerceweave-mcp approve <proposalId>   Human approval of a prepared write (interactive terminal only)
  commerceweave-mcp proposals          List proposals
  commerceweave-mcp version

Environment: see .env.example or the README. Safe default: COMMERCEWEAVE_MODE=read_only.`;

export async function cmdCheck(s: Settings) {
  out(`mode: ${s.mode}${s.demo ? '   DEMO: synthetic data, no credentials needed' : ''}`);
  out(`home: ${s.home}`);
  out(`connections: ${s.connections.length}`);
  for (const c of s.connections) out(`  - ${c.id} (${c.platform}${c.platform === 'allegro' ? ', ' + c.environment : ''})`);
  if (!s.demo && s.connections.length === 0) out('No connections configured. Set COMMERCEWEAVE_DEMO=true to try demo data, or see the README.');
  out(`token storage: ${s.tokenKey ? 'encrypted (AES-256-GCM)' : 'plaintext file with 0600 permissions (set COMMERCEWEAVE_TOKEN_KEY to encrypt)'}`);
  return 0;
}

export async function cmdListConnections(s: Settings) {
  const reg = buildRegistry(s);
  if (reg.all().length === 0) out('(none)');
  for (const c of reg.all()) out(`${c.id}\t${c.platform}\t${c.demo ? 'demo' : 'live'}\t${c.writable ? 'writable (needs approval)' : 'read-only'}`);
  return 0;
}

export async function cmdTest(s: Settings, id: string | undefined) {
  if (!id) { out('usage: test-connection <id>'); return 2; }
  const reg = buildRegistry(s);
  try {
    const c = reg.get(id);
    const d = await c.describe();
    out(`OK ${d.connectionId} (${d.platform}, ${d.environment}) ${d.storeLabel}`);
    return 0;
  } catch (e) {
    const ce = toCommerceError(e);
    out(`FAILED [${ce.code}] ${ce.message}${ce.details.hint ? '\nhint: ' + ce.details.hint : ''}`);
    return 1;
  }
}

export async function cmdDoctor(s: Settings) {
  await cmdCheck(s);
  const reg = buildRegistry(s);
  let bad = 0;
  for (const c of reg.all()) {
    process.stdout.write(`testing ${c.id} ... `);
    try { const d = await c.describe(); out(`ok (${d.storeLabel})`); } catch (e) { bad++; const ce = toCommerceError(e); out(`FAILED [${ce.code}] ${ce.message}`); }
  }
  out(bad ? `\n${bad} connection(s) failed.` : '\nAll good.');
  return bad ? 1 : 0;
}

export async function cmdSetupAllegro(s: Settings, id?: string) {
  const cfg = s.connections.find((c) => c.platform === 'allegro' && (!id || c.id === id));
  if (!cfg || cfg.platform !== 'allegro') { out('No Allegro connection configured. Set ALLEGRO_ENABLED=true, ALLEGRO_CLIENT_ID, ALLEGRO_CLIENT_SECRET (and ALLEGRO_ENVIRONMENT=sandbox|production).'); return 2; }
  const store = new TokenStore(s.home, s.tokenKey);
  const conn = new AllegroConnector(cfg, false, store);
  out(`Authorizing Allegro connection "${cfg.id}" (${cfg.environment}).`);
  if (cfg.environment === 'production') out('NOTE: this is PRODUCTION. Read access only is requested by default modes; writes still need your explicit approval each time.');
  const code = await conn.auth.startDeviceFlow();
  out(`\n1. Open: ${code.verification_uri_complete}\n2. If asked, enter code: ${code.user_code}\n3. Approve access. Waiting...`);
  await conn.auth.completeDeviceFlow(code);
  out(store.encrypted ? 'Authorized. Tokens stored encrypted.' : 'Authorized. Tokens stored in a 0600 file under COMMERCEWEAVE_HOME (plaintext). Set COMMERCEWEAVE_TOKEN_KEY to encrypt them.');
  return 0;
}

export async function cmdProposals(s: Settings) {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const store = new ApprovalStore(s.home, s.approvalTtlMs);
  const files = readdirSync(join(s.home, 'proposals')).filter((f) => f.endsWith('.json'));
  if (!files.length) out('(no proposals)');
  for (const f of files) { const p = store.get(f.replace('.json', '')); out(`${p.id}\t${p.status}\t${p.expiresAt}\t${sd(p.title)}`); }
  return 0;
}

/** The trusted channel: a human, in an interactive terminal, types the code printed next to the plan. */
export async function cmdApprove(s: Settings, id: string | undefined) {
  if (!id) { out('usage: approve <proposalId>'); return 2; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { out('Refusing: approval needs an interactive terminal operated by a human.'); return 2; }
  const store = new ApprovalStore(s.home, s.approvalTtlMs);
  const p = store.get(id);
  out(`Proposal ${p.id}  [${p.status}]  expires ${p.expiresAt}`);
  out(`Connection: ${sd(p.connectionId)} (${p.platform})\n${sd(p.title)}\n`);
  for (const c of p.changes) out(`  • ${sd(c.label)}\n      before: ${sd(c.beforeDisplay)}\n      after:  ${sd(c.afterDisplay)}`);
  if (p.warnings.length) { out('\nWarnings:'); p.warnings.forEach((w) => out('  ! ' + sd(w))); }
  const code = confirmCode(p.planHash);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\nTo approve exactly this plan type ${code} (anything else cancels): `)).trim().toUpperCase();
  rl.close();
  if (ans !== code) { out('Cancelled. Nothing approved.'); return 1; }
  try {
    store.recordHumanApproval(id);
    store.audit({ event: 'human_approval', proposalId: id });
    out(`Approved. It is valid until ${p.expiresAt} and can be executed once.`);
    return 0;
  } catch (e) {
    out(`Could not approve: ${toCommerceError(e).message}`);
    return 1;
  }
}

export { loadSettings };
