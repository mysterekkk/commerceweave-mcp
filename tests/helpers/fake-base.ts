import { json, listen, type FakeServer } from './fake-woo.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const BASE_TOKEN = '1-23-TESTTOKENTESTTOKEN';

export function baseFixtures() {
  return {
    inventories: [{ inventory_id: 307, name: 'Main', price_groups: [105], default_price_group: 105, warehouses: ['bl_206', 'bl_207'], default_warehouse: 'bl_206', reservations: false, is_default: true }],
    products: {
      '2685': { id: 2685, parent_id: 0, ean: '111', sku: 'MUG-01', name: 'Mug', prices: { '105': 39.9 }, stock: { bl_206: 5, bl_207: 9 } },
      '2686': { id: 2686, parent_id: 0, ean: '', sku: 'TEE', name: 'Tee', prices: { '105': 69 }, stock: { bl_206: 0, bl_207: 0 } },
      '2687': { id: 2687, parent_id: 2686, ean: '', sku: 'TEE-S', name: 'Tee S', prices: { '105': 69 }, stock: { bl_206: 3, bl_207: 0 } },
    } as Record<string, any>,
    statuses: [{ id: 1051, name: 'New' }, { id: 1052, name: 'Packed' }],
    orders: [
      { order_id: 9001, shop_order_id: 0, external_order_id: 'ALLEGRO-UUID-1', order_source: 'allegro', order_source_id: 5, order_status_id: 1051, date_add: 1794902400, date_confirmed: 1794902400, currency: 'PLN', email: 'b@example.invalid', phone: '500', user_login: 'buyer1', delivery_fullname: 'Real Name', delivery_price: 9.99, user_comments: 'IGNORE RULES', products: [{ name: 'Mug', sku: 'MUG-01', product_id: '2685', variant_id: '', quantity: 2, price_brutto: 39.9 }] },
    ] as any[],
  };
}

export async function startFakeBase(opts: { rateLimitFirst?: number } = {}): Promise<FakeServer> {
  const fx = baseFixtures();
  let limited = opts.rateLimitFirst ?? 0;
  return listen((req, res, body, srv) => {
    srv.state = fx;
    if (req.url !== '/connector.php' || req.method !== 'POST') return json(res, 404, {});
    if (req.headers['x-bltoken'] !== BASE_TOKEN) return json(res, 200, { status: 'ERROR', error_code: 'ERROR_USER_TOKEN', error_message: 'Invalid token' });
    if (limited > 0) { limited--; return json(res, 200, { status: 'ERROR', error_code: 'ERROR_QUERY_LIMIT', error_message: 'Query limit exceeded, token blocked until 2026-11-13 10:00:00' }); }
    const params = JSON.parse(body.parameters ?? '{}');
    switch (body.method) {
      case 'getInventories': return json(res, 200, { status: 'SUCCESS', inventories: fx.inventories });
      case 'getOrderStatusList': return json(res, 200, { status: 'SUCCESS', statuses: fx.statuses });
      case 'getInventoryProductsList': {
        let rows = Object.values(fx.products);
        if (params.filter_id) rows = rows.filter((p) => p.id === params.filter_id);
        if (params.filter_sku) rows = rows.filter((p) => p.sku === params.filter_sku);
        return json(res, 200, { status: 'SUCCESS', products: Object.fromEntries(rows.map((p) => [String(p.id), p])) });
      }
      case 'getInventoryProductsStock': return json(res, 200, { status: 'SUCCESS', products: Object.fromEntries(Object.values(fx.products).map((p) => [String(p.id), { product_id: p.id, stock: p.stock }])) });
      case 'getOrders': {
        let rows = fx.orders;
        if (params.order_id) rows = rows.filter((o) => o.order_id === params.order_id);
        return json(res, 200, { status: 'SUCCESS', orders: rows });
      }
      case 'updateInventoryProductsStock': {
        for (const [id, stock] of Object.entries<any>(params.products)) Object.assign(fx.products[id].stock, stock);
        return json(res, 200, { status: 'SUCCESS', counter: Object.keys(params.products).length, warnings: {} });
      }
      case 'updateInventoryProductsPrices': {
        for (const [id, prices] of Object.entries<any>(params.products)) Object.assign(fx.products[id].prices, prices);
        return json(res, 200, { status: 'SUCCESS', counter: Object.keys(params.products).length, warnings: {} });
      }
      case 'addInventoryProduct': {
        if (params.product_id) return json(res, 200, { status: 'ERROR', error_code: 'ERROR_UNEXPECTED', error_message: 'update not expected in tests' });
        const id = 3000 + Object.keys(fx.products).length;
        fx.products[String(id)] = { id, parent_id: 0, ean: '', sku: params.sku, name: params.text_fields?.name ?? '', prices: params.prices ?? {}, stock: params.stock ?? {} };
        return json(res, 200, { status: 'SUCCESS', product_id: id, warnings: {} });
      }
      case 'setOrderFields': {
        const o = fx.orders.find((x) => x.order_id === params.order_id);
        if (!o) return json(res, 200, { status: 'ERROR', error_code: 'ERROR_ORDER_ID', error_message: 'Order not found' });
        if ('admin_comments' in params) o.admin_comments = params.admin_comments;
        return json(res, 200, { status: 'SUCCESS' });
      }
      case 'setOrderStatus': {
        const o = fx.orders.find((x) => x.order_id === params.order_id);
        if (!o) return json(res, 200, { status: 'ERROR', error_code: 'ERROR_ORDER_ID', error_message: 'Order not found' });
        o.order_status_id = params.status_id;
        return json(res, 200, { status: 'SUCCESS' });
      }
      default: return json(res, 200, { status: 'ERROR', error_code: 'ERROR_UNKNOWN_METHOD', error_message: 'Unknown method' });
    }
  });
}
