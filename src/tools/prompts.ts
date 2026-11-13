import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Ctx } from './helpers.js';

const msg = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer, _ctx: Ctx) {
  server.registerPrompt('daily_orders', { title: 'Today\'s orders', description: 'Summarize today\'s orders across all stores without double counting.' }, () =>
    msg('Call commerce_list_orders for today (default timezone) and summarize per store: order count, gross total per currency, notable items. Mention confirmed and potential duplicates and whether the result is complete. Do not request personal data.'));
  server.registerPrompt('low_stock_check', { title: 'Low stock check', description: 'Find items that are running out.', argsSchema: z.object({ threshold: z.string().optional() }) }, (a: { threshold?: string }) =>
    msg(`Call commerce_low_stock with threshold ${a.threshold ?? '5'} and list the items grouped by store, lowest first. State which stores were incomplete.`));
  server.registerPrompt('weekly_sales', { title: 'Weekly sales summary', description: 'Revenue for the last 7 days with honest caveats.' }, () =>
    msg('Call commerce_sales_summary with days=7. Report gross revenue per currency and store, state it is revenue not profit, list excluded orders and potential duplicates, and say if data is incomplete.'));
  server.registerPrompt('stock_sync_review', { title: 'Stock discrepancy review', description: 'Compare stock between stores and propose (never apply) fixes.' }, () =>
    msg('Call commerce_find_stock_discrepancies. Explain the differences and the ambiguous/unmatched items. Do not change anything; if I name a source of truth, create a proposal with commerce_prepare_stock_update and tell me how to approve it in the terminal.'));
}
