import type { OrderStatus } from "./order-status.js";

/**
 * Order data owned by this service (table `orders`, schema owned by shopflow-infra).
 *
 * Every key is always present in the HTTP payload; `cancelledAt`/`cancellationReason` are `null`
 * because cancellation does not exist in this service (the columns stay dormant).
 */
export interface Order {
  id: string;
  customerEmail: string;
  status: OrderStatus;
  productId: string;
  quantity: number;
  totalCents: number;
  createdAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

/** The subset of an order that a database insert writes (the rest defaults in the schema). */
export interface NewOrder {
  id: string;
  customerEmail: string;
  status: OrderStatus;
  productId: string;
  quantity: number;
  totalCents: number;
  createdAt: string;
}

/** Raw input of the create-order use case, already coerced by the inbound adapter. */
export interface CreateOrderInput {
  productId: string;
  quantity: number;
  customerEmail: string;
}

/**
 * Preserved input validation rule, evaluated before any database access:
 * `!customerEmail || quantity < 1` is rejected with `400 Invalid order`.
 *
 * Note the deliberate legacy detail: a non-numeric quantity coerces to `NaN`, and `NaN < 1` is
 * `false`, so it passes this rule and fails later in the database (non-2xx, never a success and
 * never a new `400` branch).
 */
export function isValidOrderInput(input: CreateOrderInput): boolean {
  return input.customerEmail !== "" && !(input.quantity < 1);
}
