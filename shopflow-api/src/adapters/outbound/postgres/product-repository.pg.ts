import type { Pool, PoolClient } from "pg";
import type {
  ProductRepository,
  TransactionalProductRepository,
} from "../../../application/ports/out/product-repository.js";
import type { Product } from "../../../domain/product.js";
import { mapProductRow } from "./row-mappers.js";
import type { ProductRow } from "./row-mappers.js";

/** Read-side product repository (pool-scoped queries, no transaction). */
export class PgProductRepository implements ProductRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Product[]> {
    const result = await this.pool.query<ProductRow>("SELECT * FROM products ORDER BY id");
    return result.rows.map(mapProductRow);
  }

  async getById(id: string): Promise<Product | null> {
    const result = await this.pool.query<ProductRow>("SELECT * FROM products WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapProductRow(row) : null;
  }
}

/** Transaction-scoped product operations used by the create-order transaction. */
export class PgTransactionalProductRepository implements TransactionalProductRepository {
  constructor(private readonly client: PoolClient) {}

  async getById(id: string): Promise<Product | null> {
    const result = await this.client.query<ProductRow>("SELECT * FROM products WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapProductRow(row) : null;
  }

  async decrementStock(id: string, quantity: number): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE products SET stock = stock - $2
       WHERE id = $1 AND stock >= $2
       RETURNING *`,
      [id, quantity],
    );
    return result.rowCount === 1;
  }
}
