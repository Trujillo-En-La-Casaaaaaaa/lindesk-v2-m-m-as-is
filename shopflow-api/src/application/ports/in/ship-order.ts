import type { Order } from "../../../domain/order.js";

/**
 * Inbound port: administrative transition `CONFIRMED -> SHIPPED`.
 * Never touches stock and never emits a notification.
 */
export interface ShipOrderUseCase {
  execute(id: string): Promise<Order>;
}
