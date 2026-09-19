import type { Order } from "../../domain/order.js";
import { cannotShipOrder } from "../../domain/errors.js";
import type { ShipOrderUseCase } from "../ports/in/ship-order.js";
import type { OrderRepository } from "../ports/out/order-repository.js";

/**
 * Administrative shipping. The guarded `CONFIRMED -> SHIPPED` update is the whole use case: no stock
 * change, no notification, and a guard miss (unknown order or non-`CONFIRMED` status) is
 * `400 Cannot ship order`.
 */
export class ShipOrder implements ShipOrderUseCase {
  constructor(private readonly orders: OrderRepository) {}

  async execute(id: string): Promise<Order> {
    const shipped = await this.orders.markShipped(id);
    if (!shipped) {
      throw cannotShipOrder();
    }
    return shipped;
  }
}
