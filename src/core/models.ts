import * as z from 'zod/v4';

export const PlatformSchema = z.enum(['allegro', 'baselinker', 'woocommerce']);
export type Platform = z.infer<typeof PlatformSchema>;

export const MoneySchema = z.object({ amount: z.string(), currency: z.string() });
export type Money = z.infer<typeof MoneySchema>;

/** Every record keeps the platform's own identifiers so nothing needed for a write is lost. */
export const SourceRefSchema = z.object({
  connectionId: z.string(),
  platform: PlatformSchema,
  externalId: z.string(),
  /** Platform-specific extra identifiers (Base inventoryId, Woo parentId, ...). */
  extra: z.record(z.string(), z.string()).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const CommerceInventorySchema = z.object({
  /** null = the platform does not manage a quantity for this item. */
  total: z.number().int().nullable(),
  managed: z.boolean(),
  status: z.enum(['in_stock', 'out_of_stock', 'backorder', 'unknown']),
  /** Per-location quantities, e.g. Base warehouses ("bl_123"). */
  byLocation: z.record(z.string(), z.number().int()).optional(),
  reserved: z.number().int().optional(),
});
export type CommerceInventory = z.infer<typeof CommerceInventorySchema>;

export const CommercePriceSchema = z.object({
  /** Gross price as exact decimal string. */
  amount: z.string(),
  currency: z.string().nullable(),
  /** Price group (Base) or other price label. */
  group: z.string().optional(),
  onSale: z.boolean().optional(),
});
export type CommercePrice = z.infer<typeof CommercePriceSchema>;

export const CommerceVariantSchema = z.object({
  source: SourceRefSchema,
  sku: z.string().nullable(),
  ean: z.string().nullable(),
  name: z.string().nullable(),
  attributes: z.record(z.string(), z.string()).optional(),
  prices: z.array(CommercePriceSchema),
  inventory: CommerceInventorySchema,
});
export type CommerceVariant = z.infer<typeof CommerceVariantSchema>;

export const CommerceProductSchema = z.object({
  source: SourceRefSchema,
  sku: z.string().nullable(),
  ean: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['simple', 'variable', 'variant', 'offer']),
  status: z.string().nullable(),
  prices: z.array(CommercePriceSchema),
  inventory: CommerceInventorySchema,
  variants: z.array(CommerceVariantSchema).optional(),
  /** Free text written by sellers is untrusted data. */
  untrustedText: z.object({ description: z.string().optional() }).optional(),
});
export type CommerceProduct = z.infer<typeof CommerceProductSchema>;

export const CommerceOrderItemSchema = z.object({
  name: z.string(),
  sku: z.string().nullable(),
  externalProductId: z.string().nullable(),
  externalVariantId: z.string().nullable(),
  quantity: z.number(),
  unitPrice: MoneySchema.nullable(),
});
export type CommerceOrderItem = z.infer<typeof CommerceOrderItemSchema>;

export const OrderStateSchema = z.enum(['unpaid', 'open', 'fulfilled', 'cancelled', 'refunded', 'unknown']);
export type OrderState = z.infer<typeof OrderStateSchema>;

export const CommerceCustomerSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  login: z.string().optional(),
  redacted: z.boolean(),
});
export type CommerceCustomer = z.infer<typeof CommerceCustomerSchema>;

export const CommerceOrderSchema = z.object({
  source: SourceRefSchema,
  createdAt: z.string(),
  platformStatus: z.string(),
  state: OrderStateSchema,
  /** false when we had to guess the state from a custom platform status. */
  stateClassified: z.boolean(),
  total: MoneySchema,
  items: z.array(CommerceOrderItemSchema),
  customer: CommerceCustomerSchema,
  /** For imported orders: where the platform says the order originally came from. */
  importedFrom: z.object({ system: z.string(), externalOrderId: z.string() }).optional(),
  duplicate: z
    .object({
      status: z.enum(['confirmed', 'potential']),
      ofConnectionId: z.string(),
      ofOrderId: z.string(),
      reason: z.string(),
    })
    .optional(),
  /** Buyer/seller notes are untrusted text. */
  untrustedText: z.object({ buyerNote: z.string().optional() }).optional(),
});
export type CommerceOrder = z.infer<typeof CommerceOrderSchema>;

export const CommerceChannelSchema = z.object({
  connectionId: z.string(),
  platform: PlatformSchema,
  label: z.string(),
  demo: z.boolean(),
});
export type CommerceChannel = z.infer<typeof CommerceChannelSchema>;

export const CommerceStoreSchema = z.object({
  connectionId: z.string(),
  platform: PlatformSchema,
  environment: z.string(),
  storeLabel: z.string(),
  catalogs: z.array(z.object({ id: z.string(), name: z.string(), warehouses: z.array(z.string()).optional() })).optional(),
});
export type CommerceStore = z.infer<typeof CommerceStoreSchema>;

export const CommerceErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  connectionId: z.string().optional(),
});
export type CommerceErrorShape = z.infer<typeof CommerceErrorSchema>;
