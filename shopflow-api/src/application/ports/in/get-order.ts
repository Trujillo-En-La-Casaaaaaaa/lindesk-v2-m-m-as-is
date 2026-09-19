import type { Order } from "../../../domain/order.js";

/** Inbound port: read one order; a missing order is a `404 Not found` domain error. */
export interface GetOrderUseCase {
  execute(id: string): Promise<Order>;
}
