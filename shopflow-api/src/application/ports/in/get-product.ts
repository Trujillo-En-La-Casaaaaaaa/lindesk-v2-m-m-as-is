import type { Product } from "../../../domain/product.js";

/** Inbound port: read one product; a missing product is a `404 Not found` domain error. */
export interface GetProductUseCase {
  execute(id: string): Promise<Product>;
}
