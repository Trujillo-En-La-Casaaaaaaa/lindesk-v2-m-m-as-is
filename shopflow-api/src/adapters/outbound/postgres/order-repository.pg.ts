import type { Pool, PoolClient } from "pg";
import type {
  OrderRepository,
  TransactionalOrderRepository,
} from "../../../application/ports/out/order-repository.js";
import type { NewOrder, Order } from "../../../domain/order.js";
import { CONFIRMED_ORDER_STATUS, SHIPPED_ORDER_STATUS } from "../../../domain/order-status.js";
import { mapOrderRow } from "./row-mappers.js";
import type { OrderRow } from "./row-mappers.js";

/** Order reads and the guarded administrative ship transition (single statements, no explicit transaction). */
export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: Pool) {}

  async getById(id: string): Promise<Order | null> {
    const result = await this.pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapOrderRow(row) : null;
  }

  async markShipped(id: string): Promise<Order | null> {
    const result = await this.pool.query<OrderRow>(
      `UPDATE orders SET status = $2
       WHERE id = $1 AND status = $3
       RETURNING *`,
      [id, SHIPPED_ORDER_STATUS, CONFIRMED_ORDER_STATUS],
    );
    const row = result.rows[0];
    return row ? mapOrderRow(row) : null;
  }
}

/** Transaction-scoped order insert used by the create-order transaction. */
export class PgTransactionalOrderRepository implements TransactionalOrderRepository {
  constructor(private readonly client: PoolClient) {}

  async create(order: NewOrder): Promise<Order> {
    const result = await this.client.query<OrderRow>(
      `INSERT INTO orders
        (id, customer_email, status, product_id, quantity, total_cents, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        order.id,
        order.customerEmail,
        order.status,
        order.productId,
        order.quantity,
        order.totalCents,
        order.createdAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("order insert returned no row");
    }
    return mapOrderRow(row);
  }
}
