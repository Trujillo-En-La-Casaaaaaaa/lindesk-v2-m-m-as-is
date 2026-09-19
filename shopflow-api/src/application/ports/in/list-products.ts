import type { Product } from "../../../domain/product.js";

/** Inbound port: read the whole catalog ordered by id (read-only, no mutation endpoint exists). */
export interface ListProductsUseCase {
  execute(): Promise<Product[]>;
}
