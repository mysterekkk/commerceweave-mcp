export type ErrorCode =
  | 'AUTH_FAILED' | 'PERMISSION_DENIED' | 'CONFIG_INVALID' | 'RATE_LIMITED'
  | 'SERVER_ERROR' | 'TIMEOUT' | 'WRITE_OUTCOME_UNKNOWN' | 'VALIDATION_FAILED'
  | 'NOT_FOUND' | 'NOT_SUPPORTED' | 'MODE_FORBIDS' | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID' | 'STALE_PROPOSAL' | 'AMBIGUOUS_TARGET' | 'UPSTREAM_ERROR' | 'NETWORK_ERROR';

export interface ErrorDetails {
  connectionId?: string;
  status?: number;
  retryAfterMs?: number;
  correlationId?: string;
  hint?: string;
}

export class CommerceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'CommerceError';
  }
  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function toCommerceError(e: unknown): CommerceError {
  if (e instanceof CommerceError) return e;
  return new CommerceError('UPSTREAM_ERROR', e instanceof Error ? e.message : String(e));
}
