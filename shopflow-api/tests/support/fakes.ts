import type { Clock } from "../../src/application/ports/out/clock.js";
import type { IdGenerator } from "../../src/application/ports/out/id-generator.js";
import type { NotificationOutbox, TransactionalNotificationOutbox } from "../../src/application/ports/out/notification-outbox.js";
import type { NotificationPort } from "../../src/application/ports/out/notification-port.js";
import type { OrderRepository, TransactionalOrderRepository } from "../../src/application/ports/out/order-repository.js";
import type { ProductRepository, TransactionalProductRepository } from "../../src/application/ports/out/product-repository.js";
import type { TransactionContext, UnitOfWork } from "../../src/application/ports/out/unit-of-work.js";
import type {
  NewNotificationIntent,
  NotificationDeliveryRequest,
  NotificationIntent,
  NotificationRecord,
} from "../../src/domain/notification.js";
import {
  ORDER_CONFIRMATION,
  PENDING_OUTBOX_STATUS,
  SENT_OUTBOX_STATUS,
} from "../../src/domain/notification.js";
import type { NewOrder, Order } from "../../src/domain/order.js";
import { CONFIRMED_ORDER_STATUS } from "../../src/domain/order-status.js";
import type { Product } from "../../src/domain/product.js";

/**
 * In-memory test doubles for the outbound ports. They are used only by tests of the domain,
 * application and input-adapter layers; the service itself always runs against PostgreSQL and the
 * HTTP notification provider.
 *
 * The unit of work double commits a staged copy only when the callback resolves, so "a failed create
 * leaves no writes" is a real rollback in these tests instead of a mocked expectation.
 */
export interface StoreState {
  products: Product[];
  orders: Order[];
  intents: NotificationIntent[];
}

export class InMemoryStore {
  private state: StoreState;

  constructor(products: Product[] = [], orders: Order[] = [], intents: NotificationIntent[] = []) {
    this.state = {
      products: products.map((product) => ({ ...product })),
      orders: orders.map((order) => ({ ...order })),
      intents: intents.map((intent) => ({ ...intent })),
    };
  }

  get products(): readonly Product[] {
    return this.state.products;
  }

  get orders(): readonly Order[] {
    return this.state.orders;
  }

  get intents(): readonly NotificationIntent[] {
    return this.state.intents;
  }

  snapshot(): StoreState {
    return structuredClone(this.state);
  }

  restore(state: StoreState): void {
    this.state = state;
  }

  product(id: string): Product | undefined {
    return this.state.products.find((product) => product.id === id);
  }

  order(id: string): Order | undefined {
    return this.state.orders.find((order) => order.id === id);
  }

  intentsFor(orderId: string): NotificationIntent[] {
    return this.state.intents.filter((intent) => intent.orderId === orderId);
  }
}

class StagedProductRepository implements TransactionalProductRepository {
  constructor(private readonly state: StoreState) {}

  async getById(id: string): Promise<Product | null> {
    const product = this.state.products.find((candidate) => candidate.id === id);
    return product ? { ...product } : null;
  }

  async decrementStock(id: string, quantity: number): Promise<boolean> {
    const product = this.state.products.find((candidate) => candidate.id === id);
    if (!product || !(product.stock >= quantity)) {
      return false;
    }
    product.stock -= quantity;
    return true;
  }
}

class StagedOrderRepository implements TransactionalOrderRepository {
  constructor(private readonly state: StoreState) {}

  async create(order: NewOrder): Promise<Order> {
    const created: Order = { ...order, cancelledAt: null, cancellationReason: null };
    this.state.orders.push(created);
    return { ...created };
  }
}

class StagedNotificationOutbox implements TransactionalNotificationOutbox {
  constructor(private readonly state: StoreState) {}

  async enqueue(intent: NewNotificationIntent): Promise<NotificationIntent> {
    const duplicate = this.state.intents.some(
      (candidate) => candidate.orderId === intent.orderId && candidate.type === intent.type,
    );
    if (duplicate) {
      throw new Error("duplicate notification intent");
    }
    const stored: NotificationIntent = {
      ...intent,
      status: PENDING_OUTBOX_STATUS,
      attempts: 0,
      sentAt: null,
    };
    this.state.intents.push(stored);
    return { ...stored };
  }
}

/** Read-side product repository double, with call counters to prove "validation before any database access". */
export class InMemoryProductRepository implements ProductRepository {
  readonly calls = { list: 0, getById: 0 };

  constructor(private readonly store: InMemoryStore) {}

  async list(): Promise<Product[]> {
    this.calls.list += 1;
    return this.store.products.map((product) => ({ ...product }));
  }

  async getById(id: string): Promise<Product | null> {
    this.calls.getById += 1;
    const product = this.store.product(id);
    return product ? { ...product } : null;
  }
}

/** Order repository double whose `markShipped` keeps the guarded `CONFIRMED -> SHIPPED` semantics. */
export class InMemoryOrderRepository implements OrderRepository {
  readonly calls = { getById: 0, markShipped: 0 };

  constructor(private readonly store: InMemoryStore) {}

  async getById(id: string): Promise<Order | null> {
    this.calls.getById += 1;
    const order = this.store.order(id);
    return order ? { ...order } : null;
  }

  async markShipped(id: string): Promise<Order | null> {
    this.calls.markShipped += 1;
    const order = this.store.order(id);
    if (!order || order.status !== CONFIRMED_ORDER_STATUS) {
      return null;
    }
    const state = this.store.snapshot();
    const staged = state.orders.find((candidate) => candidate.id === id);
    if (!staged) {
      return null;
    }
    staged.status = "SHIPPED";
    this.store.restore(state);
    return { ...staged };
  }
}

export class InMemoryNotificationOutbox implements NotificationOutbox {
  readonly calls = { listPending: 0, markSent: 0, recordFailure: 0 };

  constructor(private readonly store: InMemoryStore) {}

  async listPending(limit: number): Promise<NotificationIntent[]> {
    this.calls.listPending += 1;
    return this.store.intents
      .filter((intent) => intent.status === PENDING_OUTBOX_STATUS)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id)
          : left.createdAt.localeCompare(right.createdAt),
      )
      .slice(0, limit)
      .map((intent) => ({ ...intent }));
  }

  async markSent(id: string, sentAt: string): Promise<void> {
    this.calls.markSent += 1;
    const state = this.store.snapshot();
    const intent = state.intents.find((candidate) => candidate.id === id);
    if (!intent) {
      throw new Error(`unknown notification intent ${id}`);
    }
    intent.status = SENT_OUTBOX_STATUS;
    intent.sentAt = sentAt;
    this.store.restore(state);
  }

  async recordFailure(id: string): Promise<void> {
    this.calls.recordFailure += 1;
    const state = this.store.snapshot();
    const intent = state.intents.find((candidate) => candidate.id === id);
    if (!intent) {
      throw new Error(`unknown notification intent ${id}`);
    }
    intent.attempts += 1;
    this.store.restore(state);
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  runs = 0;

  constructor(private readonly store: InMemoryStore) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.runs += 1;
    const staged = this.store.snapshot();
    const tx: TransactionContext = {
      products: new StagedProductRepository(staged),
      orders: new StagedOrderRepository(staged),
      outbox: new StagedNotificationOutbox(staged),
    };
    const result = await work(tx);
    this.store.restore(staged);
    return result;
  }
}

/** Notification provider double: deduplicates by idempotency key and can be made to fail N times. */
export class FakeNotificationPort implements NotificationPort {
  readonly submissions: NotificationDeliveryRequest[] = [];
  readonly records: NotificationRecord[] = [];
  failuresRemaining = 0;
  failure = new Error("notification provider unavailable");

  private readonly recordIdByKey = new Map<string, string>();

  constructor(private readonly clock: Clock) {}

  async submit(notification: NotificationDeliveryRequest): Promise<NotificationRecord> {
    this.submissions.push(structuredClone(notification));
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw this.failure;
    }
    const existingId = this.recordIdByKey.get(notification.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.records.find((record) => record.id === existingId);
      if (existing) {
        return { ...existing };
      }
    }
    const record: NotificationRecord = {
      id: `notification-${this.records.length + 1}`,
      type: notification.type,
      orderId: notification.orderId,
      createdAt: this.clock.nowIso(),
      payload: notification.payload,
    };
    this.records.push(record);
    this.recordIdByKey.set(notification.idempotencyKey, record.id);
    return { ...record };
  }

  async list(): Promise<NotificationRecord[]> {
    return this.records.map((record) => ({ ...record }));
  }

  recordsFor(orderId: string): NotificationRecord[] {
    return this.records.filter((record) => record.orderId === orderId);
  }
}

export class FixedClock implements Clock {
  constructor(private current = "2026-09-17T10:15:00.000Z") {}

  now(): Date {
    return new Date(this.current);
  }

  nowIso(): string {
    return this.current;
  }

  set(iso: string): void {
    this.current = iso;
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  nextId(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

export function sampleProduct(overrides: Partial<Product> = {}): Product {
  return { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20, ...overrides };
}

export function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    customerEmail: "customer@example.com",
    status: CONFIRMED_ORDER_STATUS,
    productId: "prod-a",
    quantity: 2,
    totalCents: 3998,
    createdAt: "2026-09-17T10:15:00.000Z",
    cancelledAt: null,
    cancellationReason: null,
    ...overrides,
  };
}

export function sampleIntent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: "intent-1",
    orderId: "order-1",
    type: ORDER_CONFIRMATION,
    payload: { customerEmail: "customer@example.com", orderId: "order-1" },
    status: PENDING_OUTBOX_STATUS,
    attempts: 0,
    createdAt: "2026-09-17T10:15:00.000Z",
    sentAt: null,
    ...overrides,
  };
}
