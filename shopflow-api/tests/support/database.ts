import pg from "pg";
import type { Product } from "../../src/domain/product.js";

export interface ProductRowShape {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
}

export interface OrderRowShape {
  id: string;
  customer_email: string;
  status: string;
  product_id: string;
  quantity: number;
  total_cents: number;
  created_at: Date;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
}

export interface OutboxRowShape {
  id: string;
  order_id: string;
  type: string;
  payload: { customerEmail?: string; orderId?: string } | null;
  status: string;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
}

/** Dedicated test database (`TEST_DATABASE_URL`, falling back to `DATABASE_URL`). */
export function resolveTestDatabaseUrl(): string | null {
  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  const value = raw?.trim();
  return value !== undefined && value !== "" ? value : null;
}

export const DATABASE_SKIP_MESSAGE =
  "[skip] PostgreSQL integration/contract tests skipped: provide TEST_DATABASE_URL (for example " +
  "postgres://shopflow:shopflow@127.0.0.1:5433/shopflow) pointing at a database whose schema was " +
  "applied by shopflow-infra (`docker compose run --rm migrate`).";

export const DATABASE_PROVISION_HINT =
  "the database is reachable but its schema is missing; apply shopflow-infra's migration first " +
  "(for example `docker compose run --rm migrate` or `psql -v ON_ERROR_STOP=1 -f migrations/001_init.sql`). " +
  "This repository owns no DDL.";

/**
 * Direct database access for integration tests only.
 *
 * It inserts/reads/deletes test rows of the tables owned by shopflow-infra and it deliberately owns no
 * DDL: when the schema is absent the suite fails with a clear pointer to the infrastructure migration.
 */
export class TestDatabase {
  private constructor(
    readonly pool: pg.Pool,
    readonly url: string,
  ) {}

  static async open(url: string): Promise<TestDatabase> {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const database = new TestDatabase(pool, url);
    await database.assertInfraSchema();
    return database;
  }

  async assertInfraSchema(): Promise<void> {
    const missing: string[] = [];
    for (const table of ["products", "orders", "notification_outbox"]) {
      const result = await this.pool.query<{ name: string | null }>(
        "SELECT to_regclass($1)::text AS name",
        [`public.${table}`],
      );
      if (!result.rows[0]?.name) {
        missing.push(table);
      }
    }
    if (missing.length > 0) {
      throw new Error(`missing table(s): ${missing.join(", ")} - ${DATABASE_PROVISION_HINT}`);
    }
  }

  async insertProduct(product: Product): Promise<void> {
    await this.pool.query(
      `INSERT INTO products (id, name, price_cents, stock)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents, stock = EXCLUDED.stock`,
      [product.id, product.name, product.priceCents, product.stock],
    );
  }

  async setStock(id: string, stock: number): Promise<void> {
    await this.pool.query("UPDATE products SET stock = $2 WHERE id = $1", [id, stock]);
  }

  async readProduct(id: string): Promise<ProductRowShape | null> {
    const result = await this.pool.query<ProductRowShape>("SELECT * FROM products WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async readOrder(id: string): Promise<OrderRowShape | null> {
    const result = await this.pool.query<OrderRowShape>("SELECT * FROM orders WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async readOrdersForProduct(productId: string): Promise<OrderRowShape[]> {
    const result = await this.pool.query<OrderRowShape>(
      "SELECT * FROM orders WHERE product_id = $1 ORDER BY created_at, id",
      [productId],
    );
    return result.rows;
  }

  async readOutboxForOrder(orderId: string): Promise<OutboxRowShape[]> {
    const result = await this.pool.query<OutboxRowShape>(
      "SELECT * FROM notification_outbox WHERE order_id = $1 ORDER BY created_at, id",
      [orderId],
    );
    return result.rows;
  }

  /** Force an intent back to `PENDING` to model a crash between provider append and mark-SENT. */
  async forcePending(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status = 'PENDING', sent_at = NULL WHERE id = $1",
      [id],
    );
  }

  async countOrders(query: string, params: unknown[]): Promise<number> {
    const result = await this.pool.query<{ count: string }>(query, params);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Remove every row this suite created for the given product ids (outbox, orders, products). */
  async removeTestData(productIds: string[]): Promise<void> {
    if (productIds.length === 0) {
      return;
    }
    await this.pool.query(
      `DELETE FROM notification_outbox
       WHERE order_id IN (SELECT id FROM orders WHERE product_id = ANY($1::text[]))`,
      [productIds],
    );
    await this.pool.query("DELETE FROM orders WHERE product_id = ANY($1::text[])", [productIds]);
    await this.pool.query("DELETE FROM products WHERE id = ANY($1::text[])", [productIds]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
