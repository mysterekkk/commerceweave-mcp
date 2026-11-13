import { isWritable, type Settings } from '../core/config.js';
import { CommerceError } from '../core/errors.js';
import { TokenStore } from '../core/token-store.js';
import { buildDemoConnectors } from '../demo/index.js';
import { AllegroConnector } from './allegro/index.js';
import { BaseConnector } from './baselinker/index.js';
import type { Connector } from './types.js';
import { WooConnector } from './woocommerce/index.js';

export class Registry {
  private readonly map = new Map<string, Connector>();
  constructor(connectors: Connector[]) {
    for (const c of connectors) this.map.set(c.id, c);
  }
  all(): Connector[] {
    return [...this.map.values()];
  }
  get(id: string): Connector {
    const c = this.map.get(id);
    if (!c) throw new CommerceError('NOT_FOUND', `Unknown connection "${id}". Known: ${[...this.map.keys()].join(', ') || '(none)'}`);
    return c;
  }
  /** Explicit ids, or every connection when omitted. */
  select(ids?: string[]): Connector[] {
    return ids && ids.length ? ids.map((i) => this.get(i)) : this.all();
  }
  /** Writes need an explicit target when more than one connection of the platform exists. */
  requireOne(id: string | undefined): Connector {
    if (id) return this.get(id);
    const all = this.all();
    if (all.length === 1) return all[0] as Connector;
    throw new CommerceError('AMBIGUOUS_TARGET', `Several connections are configured (${all.map((c) => c.id).join(', ')}); pass connectionId explicitly.`);
  }
}

export function buildRegistry(s: Settings): Registry {
  if (s.demo) return new Registry(buildDemoConnectors(s.mode !== 'read_only'));
  const store = new TokenStore(s.home, s.tokenKey);
  const list: Connector[] = s.connections.map((c) => {
    const w = isWritable(c, s.mode);
    if (c.platform === 'allegro') return new AllegroConnector(c, w, store);
    if (c.platform === 'baselinker') return new BaseConnector(c, w);
    return new WooConnector(c, w);
  });
  return new Registry(list);
}
