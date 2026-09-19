import type { Pool } from "pg";
import type { TransactionContext, UnitOfWork } from "../../../application/ports/out/unit-of-work.js";
import { PgTransactionalNotificationOutbox } from "./notification-outbox.pg.js";
import { PgTransactionalOrderRepository } from "./order-repository.pg.js";
import { PgTransactionalProductRepository } from "./product-repository.pg.js";

/**
 * PostgreSQL unit of work: `BEGIN`, hand a transaction context to the callback, `COMMIT` on success
 * and `ROLLBACK` on any error, always releasing the client. The product read, the conditional stock
 * decrement, the order insert and the outbox insert share one client (and therefore one transaction),
 * so a rejected order writes nothing.
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction: TransactionContext = {
        products: new PgTransactionalProductRepository(client),
        orders: new PgTransactionalOrderRepository(client),
        outbox: new PgTransactionalNotificationOutbox(client),
      };
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The original error is the one the caller must see; a failed rollback only means the
        // connection is already broken and will be discarded on release.
        console.error(
          `rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
