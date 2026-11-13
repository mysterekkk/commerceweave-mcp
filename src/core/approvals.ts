import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from './models.js';
import { CommerceError } from './errors.js';
import { maskString } from './redact.js';
import type { CurrentState, WriteOperation } from '../connectors/types.js';

export interface PlannedChange {
  op: WriteOperation;
  /** Exact state at proposal time. Execution aborts if the live state differs. */
  before: CurrentState;
  /** Value the field must have after execution (used for read-back verification). */
  expectedAfter: string;
  label: string;
  beforeDisplay: string;
  afterDisplay: string;
}

export type ProposalStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'rejected';

export interface Proposal {
  id: string;
  createdAt: string;
  expiresAt: string;
  connectionId: string;
  platform: Platform;
  title: string;
  changes: PlannedChange[];
  planHash: string;
  status: ProposalStatus;
  warnings: string[];
  result?: { at: string; outcomes: Array<{ label: string; ok: boolean; detail: string }> };
}

interface ApprovalRecord { proposalId: string; planHash: string; approvedAt: string; expiresAt: string; mac: string }

export function computePlanHash(connectionId: string, changes: PlannedChange[]): string {
  const canon = JSON.stringify({ connectionId, changes: changes.map((c) => ({ op: c.op, before: c.before.value, after: c.expectedAfter, rev: c.before.revision ?? null })) });
  return createHash('sha256').update(canon).digest('hex');
}

/** Short code a human must type to approve; shown only in the terminal that runs `approve`. */
export const confirmCode = (planHash: string) => planHash.slice(0, 6).toUpperCase();

export class ApprovalStore {
  constructor(private readonly home: string, private readonly ttlMs: number) {
    for (const d of ['proposals', 'approvals']) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
  }

  private pFile(id: string) {
    if (!/^cw_[a-z0-9]{12}$/.test(id)) throw new CommerceError('VALIDATION_FAILED', 'Invalid proposal id');
    return join(this.home, 'proposals', `${id}.json`);
  }
  private aFile(id: string) {
    this.pFile(id);
    return join(this.home, 'approvals', `${id}.json`);
  }

  create(p: Omit<Proposal, 'id' | 'createdAt' | 'expiresAt' | 'planHash' | 'status'>): Proposal {
    const id = 'cw_' + randomBytes(6).toString('hex');
    const now = Date.now();
    const full: Proposal = { ...p, id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(), planHash: computePlanHash(p.connectionId, p.changes), status: 'pending' };
    this.save(full);
    return full;
  }

  save(p: Proposal) {
    writeFileSync(this.pFile(p.id), JSON.stringify(p, null, 2), { mode: 0o600 });
  }

  get(id: string): Proposal {
    const f = this.pFile(id);
    if (!existsSync(f)) throw new CommerceError('NOT_FOUND', `Proposal ${id} not found`);
    const p = JSON.parse(readFileSync(f, 'utf8')) as Proposal;
    return p;
  }

  // ---- trusted channel: only the human-operated CLI calls these two ----------------------------------------------

  private key(create: boolean): Buffer {
    const f = join(this.home, 'approval.key');
    if (!existsSync(f)) {
      if (!create) throw new CommerceError('APPROVAL_REQUIRED', 'No approval key exists yet; nothing has been approved.');
      writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
      try { chmodSync(f, 0o600); } catch { /* best effort */ }
    }
    return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex');
  }

  private mac(key: Buffer, r: Omit<ApprovalRecord, 'mac'>) {
    return createHmac('sha256', key).update(`${r.proposalId}|${r.planHash}|${r.approvedAt}|${r.expiresAt}`).digest('hex');
  }

  /** Called by `commerceweave-mcp approve <id>` after the human typed the confirmation code. */
  recordHumanApproval(id: string): ApprovalRecord {
    const p = this.get(id);
    if (p.status !== 'pending') throw new CommerceError('APPROVAL_INVALID', `Proposal ${id} is ${p.status}; only pending proposals can be approved`);
    if (Date.parse(p.expiresAt) < Date.now()) throw new CommerceError('APPROVAL_INVALID', `Proposal ${id} has expired`);
    if (computePlanHash(p.connectionId, p.changes) !== p.planHash) throw new CommerceError('APPROVAL_INVALID', 'Proposal contents changed after creation');
    const base = { proposalId: id, planHash: p.planHash, approvedAt: new Date().toISOString(), expiresAt: p.expiresAt };
    const rec = { ...base, mac: this.mac(this.key(true), base) };
    writeFileSync(this.aFile(id), JSON.stringify(rec), { mode: 0o600 });
    return rec;
  }

  // ---- server side ---------------------------------------------------------------------------------------------

  /** Verifies a stored human approval is authentic, unexpired, unused and bound to exactly this plan. */
  verifyApproval(p: Proposal): void {
    const f = this.aFile(p.id);
    if (!existsSync(f)) throw new CommerceError('APPROVAL_REQUIRED', `Proposal ${p.id} has not been approved by a human. Ask the user to run: commerceweave-mcp approve ${p.id}`);
    let rec: ApprovalRecord;
    try { rec = JSON.parse(readFileSync(f, 'utf8')) as ApprovalRecord; } catch { throw new CommerceError('APPROVAL_INVALID', 'Approval record is unreadable'); }
    const expected = Buffer.from(this.mac(this.key(false), rec), 'hex');
    const got = Buffer.from(String(rec.mac), 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new CommerceError('APPROVAL_INVALID', 'Approval record failed authentication');
    if (rec.proposalId !== p.id) throw new CommerceError('APPROVAL_INVALID', 'Approval belongs to a different proposal');
    if (rec.planHash !== computePlanHash(p.connectionId, p.changes) || rec.planHash !== p.planHash) throw new CommerceError('APPROVAL_INVALID', 'Approval does not match the current plan');
    if (Date.parse(rec.expiresAt) < Date.now() || Date.parse(p.expiresAt) < Date.now()) throw new CommerceError('APPROVAL_INVALID', 'Approval has expired');
  }

  /**
   * Atomically takes ownership of the approval (rename is atomic). Exactly one caller can win, so two concurrent
   * execute calls can never both run the same approved plan. Must be called synchronously after verifyApproval.
   */
  claimApproval(id: string) {
    const a = this.aFile(id);
    try {
      renameSync(a, a + '.claimed');
    } catch {
      throw new CommerceError('APPROVAL_INVALID', `Approval for ${id} was already used (single-use).`);
    }
    try { unlinkSync(a + '.claimed'); } catch { /* keep the claimed marker if it cannot be removed */ }
  }

  audit(entry: Record<string, unknown>) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(join(this.home, 'audit.log'), maskString(line) + '\n', { mode: 0o600 });
  }
}
