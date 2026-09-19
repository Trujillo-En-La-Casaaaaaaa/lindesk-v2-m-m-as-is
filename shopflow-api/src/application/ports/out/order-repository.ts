import type { NewOrder, Order } from "../../../domain/order.js";

/** Read/write side of the order store (table `orders`) used outside a transaction. */
export interface OrderRepository {
  /** Single-row read; `null` when the order does not exist. */
  getById(id: string): Promise<Order | null>;
  /**
   * Guarded administrative transition: `UPDATE orders SET status='SHIPPED' WHERE id=$1 AND
   * status='CONFIRMED'`. Returns the updated order, or `null` when the guard matched no row
   * (unknown order or an order that is not `CONFIRMED`). Never changes stock.
   */
  markShipped(id: string): Promise<Order | null>;
}

/** Order operations that participate in the create-order transaction. */
export interface TransactionalOrderRepository {
  create(order: NewOrder): Promise<Order>;
}
