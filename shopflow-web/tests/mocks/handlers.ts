import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";
import type {
  CreateOrderRequest,
  NotificationRecord,
  Order,
  OrderStatus,
  Product,
} from "../../src/api/types";

/**
 * MSW handlers for the frozen `/api/*` contract (paths, status codes and messages preserved from the
 * monolith). They are stateful so the route tests exercise the real flow - order creation decrements
 * stock and `POST /api/orders/:id/ship` is a guarded one-way transition - without any database.
 */

/** The seeded product data documented in the handoff (`shopflow-infra` owns the real seed). */
export const SEED_PRODUCTS: readonly Product[] = [
  { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
  { id: "prod-b", name: "Product B", priceCents: 999, stock: 10 },
];

const CREATED_AT = "2024-01-01T00:00:00.000Z";

export interface SeedOrderInput {
  productId?: string;
  quantity?: number;
  customerEmail?: string;
  status?: OrderStatus;
}

export interface ApiMock {
  handlers: HttpHandler[];
  reset: () => void;
  readonly products: Product[];
  readonly orders: Order[];
  readonly notifications: NotificationRecord[];
  /** Number of `POST /api/orders/:id/ship` requests the mock answered. */
  readonly shipCalls: number;
  /** Puts an order in the store without touching stock (used to render order detail views). */
  seedOrder: (input?: SeedOrderInput) => Order;
}

export function createApiMock(): ApiMock {
  let products: Product[] = [];
  let orders: Order[] = [];
  let notifications: NotificationRecord[] = [];
  let shipCalls = 0;

  function reset(): void {
    products = SEED_PRODUCTS.map((product) => ({ ...product }));
    orders = [];
    notifications = [];
    shipCalls = 0;
  }

  reset();

  function findProduct(id: string): Product | undefined {
    return products.find((product) => product.id === id);
  }

  function findOrder(id: string): Order | undefined {
    return orders.find((order) => order.id === id);
  }

  function seedOrder(input: SeedOrderInput = {}): Order {
    const productId = input.productId ?? "prod-a";
    const quantity = input.quantity ?? 1;
    const product = findProduct(productId);
    const order: Order = {
      id: `order-${orders.length + 1}`,
      customerEmail: input.customerEmail ?? "seed@example.com",
      status: input.status ?? "CONFIRMED",
      productId,
      quantity,
      totalCents: (product?.priceCents ?? 0) * quantity,
      createdAt: CREATED_AT,
      cancelledAt: null,
      cancellationReason: null,
    };
    orders.push(order);
    return order;
  }

  const handlers: HttpHandler[] = [
    http.get("/api/health", () => HttpResponse.json({ ok: true })),

    http.get("/api/products", () =>
      HttpResponse.json([...products].sort((left, right) => left.id.localeCompare(right.id))),
    ),

    http.get("/api/products/:id", ({ params }) => {
      const product = findProduct(String(params.id));
      return product === undefined
        ? HttpResponse.json({ error: "Not found" }, { status: 404 })
        : HttpResponse.json(product);
    }),

    http.post("/api/orders", async ({ request }) => {
      const body = (await request.json()) as Partial<CreateOrderRequest>;
      const productId = String(body.productId ?? "");
      const quantity = Number(body.quantity ?? 0);
      const customerEmail = String(body.customerEmail ?? "");

      if (customerEmail === "" || quantity < 1) {
        return HttpResponse.json({ error: "Invalid order" }, { status: 400 });
      }

      const product = findProduct(productId);
      if (product === undefined) {
        return HttpResponse.json({ error: "Product not found" }, { status: 404 });
      }
      if (quantity > product.stock) {
        return HttpResponse.json({ error: "Insufficient stock" }, { status: 400 });
      }

      product.stock -= quantity;
      const order = seedOrder({ productId, quantity, customerEmail });
      notifications.push({
        id: `notification-${notifications.length + 1}`,
        type: "ORDER_CONFIRMATION",
        orderId: order.id,
        createdAt: CREATED_AT,
        payload: { customerEmail, orderId: order.id },
      });

      return HttpResponse.json(order, { status: 201 });
    }),

    http.get("/api/orders/:id", ({ params }) => {
      const order = findOrder(String(params.id));
      return order === undefined
        ? HttpResponse.json({ error: "Not found" }, { status: 404 })
        : HttpResponse.json(order);
    }),

    http.post("/api/orders/:id/ship", ({ params }) => {
      shipCalls += 1;
      const order = findOrder(String(params.id));
      if (order === undefined || order.status !== "CONFIRMED") {
        return HttpResponse.json({ error: "Cannot ship order" }, { status: 400 });
      }
      order.status = "SHIPPED";
      return HttpResponse.json(order);
    }),

    http.get("/api/notifications", () => HttpResponse.json(notifications)),
  ];

  return {
    handlers,
    reset,
    get products() {
      return products;
    },
    get orders() {
      return orders;
    },
    get notifications() {
      return notifications;
    },
    get shipCalls() {
      return shipCalls;
    },
    seedOrder,
  };
}

/** Shared mock used by the MSW server in `tests/setupTests.ts`. */
export const apiMock = createApiMock();
export const handlers = apiMock.handlers;
