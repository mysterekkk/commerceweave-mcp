// Starts the real built server in demo mode, calls a few tools through the official MCP client and prints
// the actual responses. Used to generate docs/demo-output.md. Run: npm run build && node scripts/demo-transcript.mjs
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', COMMERCEWEAVE_DEMO: 'true', COMMERCEWEAVE_HOME: mkdtempSync(join(tmpdir(), 'cw-demo-')) },
  stderr: 'ignore',
});
const client = new Client({ name: 'demo-transcript', version: '0.0.0' });
await client.connect(transport);
const calls = [
  ['commerce_sales_summary', { days: 7 }],
  ['commerce_low_stock', { threshold: 3 }],
  ['commerce_find_stock_discrepancies', { connectionIds: ['demo-base', 'demo-woo'] }],
];
const slim = (name, obj) => {
  if (name === 'commerce_low_stock') return { threshold: obj.threshold, count: obj.count, items: obj.items.map((i) => ({ connectionId: i.connectionId, sku: i.sku, total: i.total })), complete: obj.complete };
  if (name === 'commerce_find_stock_discrepancies') return { matchedGroups: obj.matchedGroups, inSync: obj.inSync, discrepancies: obj.discrepancies.map((d) => ({ key: d.key, basis: d.basis, quantities: d.members.map((m) => `${m.connectionId}=${m.quantity}`), difference: d.difference })), complete: obj.complete };
  return obj;
};
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  const obj = JSON.parse(r.content[0].text);
  process.stdout.write(`### ${name} ${JSON.stringify(args)}\n\n\`\`\`json\n${JSON.stringify(slim(name, obj), null, 2)}\n\`\`\`\n\n`);
}
await client.close();
