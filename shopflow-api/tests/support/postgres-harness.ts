import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { HttpUseCases } from "../../src/adapters/inbound/http/controllers.js";
import { PgNotificationOutbox } from "../../src/adapters/outbound/postgres/notification-outbox.pg.js";
import { PgOrderRepository } from "../../src/adapters/outbound/postgres/order-repository.pg.js";
import { PgProductRepository } from "../../src/adapters/outbound/postgres/product-repository.pg.js";
import { PgUnitOfWork } from "../../src/adapters/outbound/postgres/unit-of-work.pg.js";
import { SystemClock } from "../../src/application/ports/out/clock.js";
import type { Clock } from "../../src/application/ports/out/clock.js";
import type { IdGenerator } from "../../src/application/ports/out/id-generator.js";
import { UuidIdGenerator } from "../../src/application/ports/out/id-generator.js";
import type { NotificationPort } from "../../src/application/ports/out/notification-port.js";
import { CreateOrder } from "../../src/application/use-cases/create-order.use-case.js";
import { DeliverPendingNotifications } from "../../src/application/use-cases/deliver-pending-notifications.use-case.js";
import { GetOrder } from "../../src/application/use-cases/get-order.use-case.js";
import { GetProduct } from "../../src/application/use-cases/get-product.use-case.js";
import { ListNotifications } from "../../src/application/use-cases/list-notifications.use-case.js";
import { ListProducts } from "../../src/application/use-cases/list-products.use-case.js";
import { NotificationDispatcher } from "../../src/application/use-cases/notification-dispatcher.js";
import type { Sleep } from "../../src/application/use-cases/notification-dispatcher.js";
import { ShipOrder } from "../../src/application/use-cases/ship-order.use-case.js";
import { FakeNotificationPort, FixedClock } from "./fakes.js";

export interface PostgresHarnessOptions {
  /** Notification provider double: it deduplicates by idempotency key and can fail on demand. */
  notifications?: NotificationPort;
  ids?: IdGenerator;
  clock?: Clock;
  retryAttempts?: number;
  sleep?: Sleep;
  pendingBatchSize?: number;
}

/**
 * The real PostgreSQL adapters with the real use cases, on a caller-owned pool. Only the notification
 * provider is replaced (it is an external service owned by shopflow-infra), so every persistence claim
 * - transaction atomicity, the conditional decrement, row mapping, the outbox - is exercised against
 * a real database.
 */
export function createPostgresHarness(pool: pg.Pool, options: PostgresHarnessOptions = {}) {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidIdGenerator();
  const notifications = options.notifications ?? new FakeNotificationPort(new FixedClock());

  const productRepository = new PgProductRepository(pool);
  const orderRepository = new PgOrderRepository(pool);
  const outbox = new PgNotificationOutbox(pool);
  const unitOfWork = new PgUnitOfWork(pool);

  const dispatcher = new NotificationDispatcher(
    outbox,
    notifications,
    clock,
    options.retryAttempts ?? 3,
    options.sleep ?? (async () => {}),
  );
  const deliverPendingNotifications = new DeliverPendingNotifications(
    outbox,
    dispatcher,
    options.pendingBatchSize ?? 50,
  );

  const useCases: HttpUseCases & { deliverPendingNotifications: DeliverPendingNotifications } = {
    listProducts: new ListProducts(productRepository),
    getProduct: new GetProduct(productRepository),
    createOrder: new CreateOrder(unitOfWork, dispatcher, clock, ids),
    getOrder: new GetOrder(orderRepository),
    shipOrder: new ShipOrder(orderRepository),
    listNotifications: new ListNotifications(notifications),
    deliverPendingNotifications,
  };

  return { useCases, dispatcher, deliverPendingNotifications, outbox, productRepository, orderRepository, ids, clock, notifications };
}

export type PostgresHarness = ReturnType<typeof createPostgresHarness>;

/** Deterministic id generator for failure injection on primary keys. */
export class FixedIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly ids: string[]) {}

  nextId(): string {
    const next = this.ids[this.counter];
    this.counter += 1;
    if (next === undefined) {
      throw new Error("FixedIdGenerator ran out of ids");
    }
    return next;
  }
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
