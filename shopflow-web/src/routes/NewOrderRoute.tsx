import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createOrder, listProducts } from "../api/client";
import { toErrorMessage } from "../api/errors";
import type { CreateOrderRequest, Product } from "../api/types";
import { OrderForm } from "../components/OrderForm";

/**
 * `GET /orders/new` - "Create order". A successful `POST /api/orders` navigates to `/orders/<id>`;
 * a rejected one shows the API message in place without navigating away.
 */
export function NewOrderRoute() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    listProducts()
      .then((loaded) => {
        if (active) {
          setProducts(loaded);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(toErrorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(input: CreateOrderRequest): Promise<void> {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const order = await createOrder(input);
      setSubmitError(null);
      navigate(`/orders/${encodeURIComponent(order.id)}`);
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>Create order</h1>
      {loadError === null ? null : <p role="alert">{loadError}</p>}
      {products === null ? (loadError === null ? <p>Loading&hellip;</p> : null) : null}
      {products === null ? null : (
        <OrderForm
          products={products}
          errorMessage={submitError}
          onSubmit={(input) => void handleSubmit(input)}
        />
      )}
    </section>
  );
}
