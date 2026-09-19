import type { Product } from "../../../domain/product.js";

/** Read side of the product store (table `products`). */
export interface ProductRepository {
  /** `SELECT * FROM products ORDER BY id`. */
  list(): Promise<Product[]>;
  /** Single-row read; `null` when the product does not exist. */
  getById(id: string): Promise<Product | null>;
}

/** Product operations that participate in a transaction (must run inside a unit of work). */
export interface TransactionalProductRepository {
  /** Read of the product inside the order transaction. */
  getById(id: string): Promise<Product | null>;
  /**
   * Conditional decrement: `UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2`.
   * Returns `false` when no row matched, which is the "insufficient stock" signal. Because the
   * condition is evaluated on the committed stock at update time, two concurrent orders for the last
   * unit cannot both succeed.
   */
  decrementStock(id: string, quantity: number): Promise<boolean>;
}
