import type { Order } from "../api/types";

export interface OrderSummaryProps {
  order: Order;
}

/**
 * The full order object pretty-printed with 2-space indentation, exactly as the legacy order page
 * rendered it.
 */
export function OrderSummary({ order }: OrderSummaryProps) {
  return <pre className="order-summary">{JSON.stringify(order, null, 2)}</pre>;
}
