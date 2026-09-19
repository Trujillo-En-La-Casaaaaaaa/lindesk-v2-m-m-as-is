import type { Product } from "../../domain/product.js";
import type { ListProductsUseCase } from "../ports/in/list-products.js";
import type { ProductRepository } from "../ports/out/product-repository.js";

/** Catalog read; the repository returns the rows ordered by `id`, which is part of the contract. */
export class ListProducts implements ListProductsUseCase {
  constructor(private readonly products: ProductRepository) {}

  execute(): Promise<Product[]> {
    return this.products.list();
  }
}
