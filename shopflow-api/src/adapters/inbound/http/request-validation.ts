import type { CreateOrderInput } from "../../../domain/order.js";

/**
 * Request parsing preserved from the legacy Express handler, including the exact coercion:
 *
 * ```ts
 * productId:     String(req.body.productId ?? "")
 * quantity:      Number(req.body.quantity ?? 0)
 * customerEmail: String(req.body.customerEmail ?? "")
 * ```
 *
 * The coercion is what makes a non-numeric quantity reach the database as `NaN` (the legacy `500`
 * path) instead of turning into a new `400` validation branch, so it must not be "improved".
 */
export function parseCreateOrderBody(body: unknown): CreateOrderInput {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    productId: String(source.productId ?? ""),
    quantity: Number(source.quantity ?? 0),
    customerEmail: String(source.customerEmail ?? ""),
  };
}

/** Path parameters are opaque strings; no parsing, trimming or validation is applied. */
export function parsePathId(value: string | undefined): string {
  return value ?? "";
}
