import type { HttpUseCases } from "../../src/adapters/inbound/http/controllers.js";
import { CreateOrder } from "../../src/application/use-cases/create-order.use-case.js";
import { DeliverPendingNotifications } from "../../src/application/use-cases/deliver-pending-notifications.use-case.js";
import { GetOrder } from "../../src/application/use-cases/get-order.use-case.js";
import { GetProduct } from "../../src/application/use-cases/get-product.use-case.js";
import { ListNotifications } from "../../src/application/use-cases/list-notifications.use-case.js";
import { ListProducts } from "../../src/application/use-cases/list-products.use-case.js";
import { NotificationDispatcher } from "../../src/application/use-cases/notification-dispatcher.js";
import { ShipOrder } from "../../src/application/use-cases/ship-order.use-case.js";
import type { Sleep } from "../../src/application/use-cases/notification-dispatcher.js";
import type { NotificationIntent } from "../../src/domain/notification.js";
import type { Order } from "../../src/domain/order.js";
import type { Product } from "../../src/domain/product.js";
import {
  FakeNotificationPort,
  FixedClock,
  InMemoryNotificationOutbox,
  InMemoryOrderRepository,
  InMemoryProductRepository,
  InMemoryStore,
  InMemoryUnitOfWork,
  SequenceIdGenerator,
} from "./fakes.js";

export interface HarnessOptions {
  products?: Product[];
  orders?: Order[];
  intents?: NotificationIntent[];
  notificationRetryAttempts?: number;
  pendingBatchSize?: number;
  sleep?: Sleep;
}

/**
 * Wires the real use cases onto the in-memory doubles. Every test in `tests/unit`, the architecture
 * suite and the database-free characterization cases use this harness, so the behaviour under test is
 * the production application code - only the adapters are replaced.
 */
export function createHarness(options: HarnessOptions = {}) {
  const store = new InMemoryStore(options.products ?? [], options.orders ?? [], options.intents ?? []);
  const clock = new FixedClock();
  const ids = new SequenceIdGenerator("id");

  const productRepository = new InMemoryProductRepository(store);
  const orderRepository = new InMemoryOrderRepository(store);
  const outbox = new InMemoryNotificationOutbox(store);
  const unitOfWork = new InMemoryUnitOfWork(store);
  const notifications = new FakeNotificationPort(clock);

  const dispatcher = new NotificationDispatcher(
    outbox,
    notifications,
    clock,
    options.notificationRetryAttempts ?? 3,
    options.sleep ?? (async () => {}),
  );
  const deliverPending = new DeliverPendingNotifications(
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
    deliverPendingNotifications: deliverPending,
  };

  return {
    store,
    clock,
    ids,
    productRepository,
    orderRepository,
    outbox,
    unitOfWork,
    notifications,
    dispatcher,
    deliverPending,
    useCases,
  };
}

export type TestHarness = ReturnType<typeof createHarness>;
