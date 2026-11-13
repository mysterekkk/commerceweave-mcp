import { maskString } from './redact.js';

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof levels;
let current: LogLevel = 'info';

export function setLogLevel(l: LogLevel) {
  current = l;
}

/** All diagnostics go to stderr; stdout is reserved for the MCP protocol. */
export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  if (levels[level] < levels[current]) return;
  const line = `[commerceweave] ${level.toUpperCase()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  process.stderr.write(maskString(line) + '\n');
}
