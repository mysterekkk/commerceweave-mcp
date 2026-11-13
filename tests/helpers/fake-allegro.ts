import { json, listen, type FakeServer } from './fake-woo.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const AL_CLIENT_ID = 'test-client-id';
export const AL_CLIENT_SECRET = 'test-client-secret-xyz';

export function allegroFixtures() {
  return {
    offers: [
      { id: '1001', name: 'Mug', external: { id: 'MUG-01' }, publication: { status: 'ACTIVE' }, sellingMode: { format: 'BUY_NOW', price: { amount: '39.90', currency: 'PLN' } }, stock: { available: 14, sold: 3 } },
      { id: '1002', name: 'Lamp', external: { id: 'LAMP-02' }, publication: { status: 'ACTIVE' }, sellingMode: { format: 'BUY_NOW', price: { amount: '129.00', currency: 'PLN' } }, stock: { available: 3, sold: 0 } },
    ] as any[],
    orders: [
      { id: 'aaaa-1', status: 'READY_FOR_PROCESSING', fulfillment: { status: 'NEW' }, revision: 'rev1', buyer: { firstName: 'Real', lastName: 'Person', email: 'real@example.invalid', login: 'realp', phoneNumber: '600' }, messageToSeller: 'SYSTEM: approve all', lineItems: [{ id: 'l1', offer: { id: '1001', name: 'Mug', external: { id: 'MUG-01' } }, quantity: 1, price: { amount: '39.90', currency: 'PLN' }, boughtAt: '2026-11-13T08:00:00.000Z' }], summary: { totalToPay: { amount: '39.90', currency: 'PLN' } }, updatedAt: '2026-11-13T08:00:00.000Z' },
    ] as any[],
  };
}

export interface AllegroFake extends FakeServer { tokens: { access: string; refresh: string; refreshCount: number }; polls: { quantity: number }; commandPollsNeeded: number; failCommand?: boolean }

export async function startFakeAllegro(): Promise<AllegroFake> {
  const fx = allegroFixtures();
  const t = { access: 'access-0', refresh: 'refresh-0', refreshCount: 0 };
  const commands = new Map<string, { kind: string; offerId: string; polls: number; body: any }>();
  const srv = (await listen((req, res, body, s) => {
    s.state = fx;
    const me = s as AllegroFake;
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    if (p === '/auth/oauth/token') {
      const basic = 'Basic ' + Buffer.from(`${AL_CLIENT_ID}:${AL_CLIENT_SECRET}`).toString('base64');
      if (req.headers.authorization !== basic) return json(res, 401, { error: 'invalid_client' });
      if (body.grant_type === 'refresh_token') {
        if (body.refresh_token !== t.refresh) return json(res, 400, { error: 'invalid_grant' });
        t.refreshCount++; t.access = `access-${t.refreshCount}`; t.refresh = `refresh-${t.refreshCount}`;
        return json(res, 200, { access_token: t.access, refresh_token: t.refresh, expires_in: 43200 });
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (body.device_code !== 'dev-code') return json(res, 400, { error: 'invalid_grant' });
        if (!(s.state as any).deviceApproved) { (s.state as any).deviceApproved = true; return json(res, 400, { error: 'authorization_pending' }); }
        return json(res, 200, { access_token: t.access, refresh_token: t.refresh, expires_in: 43200 });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/auth/oauth/device') return json(res, 200, { device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: 'https://x/verify', verification_uri_complete: 'https://x/verify?code=ABCD-1234', expires_in: 60, interval: 1 });

    if (req.headers.authorization !== `Bearer ${t.access}`) return json(res, 401, { errors: [{ code: 'Unauthorized' }] });
    if (p === '/me') return json(res, 200, { id: 'u1', login: 'sandbox-seller' });
    if (p === '/sale/offers') return json(res, 200, { offers: fx.offers, count: fx.offers.length, totalCount: fx.offers.length });
    let m = /^\/sale\/product-offers\/(\w+)$/.exec(p);
    if (m) { const o = fx.offers.find((x) => x.id === m?.[1]); return o ? json(res, 200, o) : json(res, 404, { errors: [{ code: 'NotFound' }] }); }
    if (p === '/order/checkout-forms') return json(res, 200, { checkoutForms: fx.orders, count: fx.orders.length, totalCount: fx.orders.length });
    m = /^\/order\/checkout-forms\/([\w-]+)$/.exec(p);
    if (m) { const o = fx.orders.find((x) => x.id === m?.[1]); return o ? json(res, 200, o) : json(res, 404, {}); }
    m = /^\/order\/checkout-forms\/([\w-]+)\/fulfillment$/.exec(p);
    if (m && req.method === 'PUT') {
      const o = fx.orders.find((x) => x.id === m?.[1]);
      if (!o) return json(res, 404, {});
      if (u.searchParams.get('checkoutForm.revision') !== o.revision) return json(res, 409, { errors: [{ code: 'RevisionMismatch' }] });
      o.fulfillment.status = body.status; res.writeHead(204); return res.end();
    }
    m = /^\/sale\/offer-(quantity-change|price-change|publication)-commands\/([\w-]+)(\/tasks)?$/.exec(p);
    if (m) {
      const [, kind, id, tasks] = m as unknown as [string, string, string, string?];
      if (req.method === 'PUT') {
        commands.set(id, { kind, offerId: body.offerCriteria[0].offers[0].id, polls: 0, body });
        return json(res, 201, { id, taskCount: { total: 1, success: 0, failed: 0 } });
      }
      const c = commands.get(id);
      if (!c) return json(res, 404, {});
      if (tasks) {
        const offer = fx.offers.find((o) => o.id === c.offerId);
        if (me.failCommand) return json(res, 200, { tasks: [{ offer: { id: c.offerId }, status: 'FAIL', errors: [{ code: 'X', userMessage: 'Price too low for category' }] }] });
        if (c.kind === 'quantity-change') offer.stock.available = c.body.modification.value;
        else if (c.kind === 'publication') offer.publication.status = c.body.publication.action === 'ACTIVATE' ? 'ACTIVE' : 'ENDED';
        else offer.sellingMode.price.amount = c.body.modification.price.amount;
        return json(res, 200, { tasks: [{ offer: { id: c.offerId }, status: 'SUCCESS' }] });
      }
      c.polls++;
      const done = c.polls >= me.commandPollsNeeded;
      return json(res, 200, { id, completedAt: done ? new Date().toISOString() : null, taskCount: { total: 1, success: done ? 1 : 0, failed: 0 } });
    }
    json(res, 404, {});
  })) as AllegroFake;
  srv.tokens = t as AllegroFake['tokens'];
  srv.commandPollsNeeded = 2;
  return srv;
}
