import type { Order } from "../../domain/order.js";
import { notFound } from "../../domain/errors.js";
import type { GetOrderUseCase } from "../ports/in/get-order.js";
import type { OrderRepository } from "../ports/out/order-repository.js";

/** Single order read; a missing id is a `404 Not found`. */
export class GetOrder implements GetOrderUseCase {
  constructor(private readonly orders: OrderRepository) {}

  async execute(id: string): Promise<Order> {
    const order = await this.orders.getById(id);
    if (!order) {
      throw notFound();
    }
    return order;
  }
}
