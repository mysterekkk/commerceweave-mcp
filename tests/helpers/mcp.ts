import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DIST = resolve(__dirname, '../../dist/index.js');

export function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'cw-test-'));
}

/** Spawns the REAL built server over stdio and returns a connected MCP client. */
export async function connectStdio(env: Record<string, string>) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', COMMERCEWEAVE_HOME: tmpHome(), ...env },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => stderr.push(String(d)));
  const client = new Client({ name: 'cw-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

export function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? '').join('\n');
}
export function jsonOf<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}
