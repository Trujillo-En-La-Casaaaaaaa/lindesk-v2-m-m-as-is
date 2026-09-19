import type { CreateOrderInput, Order } from "../../../domain/order.js";

export type CreateOrderCommand = CreateOrderInput;

/**
 * Inbound port: create an order.
 *
 * Contract of the use case (preserved from the monolith):
 * validate input -> (single transaction) read product -> conditional stock decrement -> insert
 * order -> insert exactly one `ORDER_CONFIRMATION` outbox intent -> commit -> deliver the
 * notification in-request with retries -> return the created order.
 */
export interface CreateOrderUseCase {
  execute(command: CreateOrderCommand): Promise<Order>;
}
