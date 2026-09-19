import type { TransactionalOrderRepository } from "./order-repository.js";
import type { TransactionalNotificationOutbox } from "./notification-outbox.js";
import type { TransactionalProductRepository } from "./product-repository.js";

/**
 * The transactional context handed to a unit-of-work callback. Every repository here is bound to the
 * same database transaction, so the product read, the conditional decrement, the order insert and
 * the outbox insert either all commit or all roll back.
 */
export interface TransactionContext {
  products: TransactionalProductRepository;
  orders: TransactionalOrderRepository;
  outbox: TransactionalNotificationOutbox;
}

/**
 * Transaction boundary port; the only way application code starts, commits or rolls back a
 * transaction.
 */
export interface UnitOfWork {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
