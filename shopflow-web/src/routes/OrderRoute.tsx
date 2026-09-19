import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getOrder } from "../api/client";
import { isNotFoundError, toErrorMessage } from "../api/errors";
import type { Order } from "../api/types";
import { OrderSummary } from "../components/OrderSummary";
import { ShipOrderButton } from "../components/ShipOrderButton";

/**
 * `GET /orders/:id` - "Order <id>" with the pretty-printed order, the administrative SHIPPED button
 * (only while the order is `CONFIRMED`), a Home link and `Not found` for an unknown id.
 */
export function OrderRoute() {
  const { id = "" } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setOrder(null);
    setNotFound(false);
    setErrorMessage(null);
    getOrder(id)
      .then((loaded) => {
        if (active) {
          setOrder(loaded);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        if (isNotFoundError(error)) {
          setNotFound(true);
        } else {
          setErrorMessage(toErrorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [id]);

  // The legacy order page answered an unknown id with the body text `Not found`.
  if (notFound) {
    return <p>Not found</p>;
  }

  return (
    <section>
      <h1>Order {id}</h1>
      {errorMessage === null ? null : <p role="alert">{errorMessage}</p>}
      {order === null ? (errorMessage === null ? <p>Loading&hellip;</p> : null) : <OrderSummary order={order} />}
      {order !== null && order.status === "CONFIRMED" ? (
        <ShipOrderButton orderId={order.id} onShipped={setOrder} onError={setErrorMessage} />
      ) : null}
      <p>
        <Link to="/">Home</Link>
      </p>
    </section>
  );
}
