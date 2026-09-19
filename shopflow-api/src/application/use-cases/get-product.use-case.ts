import type { Product } from "../../domain/product.js";
import { notFound } from "../../domain/errors.js";
import type { GetProductUseCase } from "../ports/in/get-product.js";
import type { ProductRepository } from "../ports/out/product-repository.js";

/** Single product read; a missing (or unknown-format) id is a `404 Not found`, never a driver error. */
export class GetProduct implements GetProductUseCase {
  constructor(private readonly products: ProductRepository) {}

  async execute(id: string): Promise<Product> {
    const product = await this.products.getById(id);
    if (!product) {
      throw notFound();
    }
    return product;
  }
}
