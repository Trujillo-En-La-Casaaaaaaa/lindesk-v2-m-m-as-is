import { useState } from "react";
import { shipOrder } from "../api/client";
import { toErrorMessage } from "../api/errors";
import type { Order } from "../api/types";

export interface ShipOrderButtonProps {
  orderId: string;
  /** Called with the API's authoritative order after a successful `POST /api/orders/:id/ship`. */
  onShipped: (order: Order) => void;
  /** Called with the API's verbatim error message when the transition is refused. */
  onError: (message: string) => void;
}

/**
 * Administrative SHIPPED action. It is rendered by the order detail view only when the order is
 * `CONFIRMED`, so this button is the only place that issues `POST /api/orders/:id/ship`.
 */
export function ShipOrderButton({ orderId, onShipped, onError }: ShipOrderButtonProps) {
  const [shipping, setShipping] = useState(false);

  async function handleClick(): Promise<void> {
    setShipping(true);
    try {
      onShipped(await shipOrder(orderId));
    } catch (error) {
      onError(toErrorMessage(error));
    } finally {
      setShipping(false);
    }
  }

  return (
    <button type="button" onClick={() => void handleClick()} disabled={shipping}>
      Mark SHIPPED
    </button>
  );
}
