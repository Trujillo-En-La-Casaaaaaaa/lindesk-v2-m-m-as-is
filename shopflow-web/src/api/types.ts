/**
 * The frozen `/api/*` contract as seen by the browser (owned by shopflow-api).
 *
 * The SPA mirrors the API payloads exactly and holds no business rule: it renders what the API
 * returns and displays the API's `error` messages verbatim.
 */

/** `GET /api/products`, `GET /api/products/:id`. */
export interface Product {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

/**
 * `CANCELLED` is kept only for type compatibility with stored data: cancellation does not exist in
 * this system and no UI action may ever request it.
 */
export type OrderStatus = "CONFIRMED" | "SHIPPED" | "CANCELLED";

/** `POST /api/orders` (201), `GET /api/orders/:id`, `POST /api/orders/:id/ship`. */
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

/** Request body of `POST /api/orders`. */
export interface CreateOrderRequest {
  productId: string;
  quantity: number;
  customerEmail: string;
}

/**
 * `GET /api/notifications` record shape. Kept for contract completeness: the confirmation
 * notification is created by the API and there is no notification UI in this repository.
 */
export interface NotificationRecord {
  id: string;
  type: string;
  orderId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

/** Error envelope of the frozen contract: `{"error":"<message>"}`. */
export interface ApiErrorBody {
  error?: string;
}
