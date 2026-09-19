/**
 * Order status values and the only legal status transition of the preserved behaviour:
 * `CONFIRMED -> SHIPPED` (administrative shipping).
 *
 * `CANCELLED` is a dormant legacy value kept for data compatibility. No use case, port or route may
 * produce it, and no transition into it exists (customer cancellation is not part of this service).
 */
export type OrderStatus = "CONFIRMED" | "SHIPPED" | "CANCELLED";

/** Status written when an order is created. */
export const CONFIRMED_ORDER_STATUS: OrderStatus = "CONFIRMED";

/** Status written by the administrative ship transition. */
export const SHIPPED_ORDER_STATUS: OrderStatus = "SHIPPED";

/** Dormant legacy value, preserved in the type union and in the stored data only. */
export const DORMANT_CANCELLED_ORDER_STATUS: OrderStatus = "CANCELLED";

const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  CONFIRMED: [SHIPPED_ORDER_STATUS],
  SHIPPED: [],
  CANCELLED: [],
};

/**
 * True only for the one preserved transition (`CONFIRMED -> SHIPPED`).
 * Shipping a `SHIPPED` or `CANCELLED` order is not a legal transition.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Guard used by the administrative ship use case: only `CONFIRMED` orders may ship. */
export function canShip(status: OrderStatus): boolean {
  return canTransition(status, SHIPPED_ORDER_STATUS);
}
