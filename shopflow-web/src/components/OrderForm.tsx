import { useState } from "react";
import type { FormEvent } from "react";
import type { CreateOrderRequest, Product } from "../api/types";
import { ProductSelect } from "./ProductSelect";

export interface OrderFormProps {
  products: Product[];
  /** Message of the failed `POST /api/orders`, displayed verbatim; `null` when there is none. */
  errorMessage: string | null;
  onSubmit: (input: CreateOrderRequest) => void;
}

const PRODUCT_FIELD_ID = "productId";
const QUANTITY_FIELD_ID = "quantity";
const EMAIL_FIELD_ID = "customerEmail";

/**
 * The legacy order form: a product `<select>`, a quantity number input defaulting to `1` with
 * `min=1`, a required email input and the "Place order" submit button.
 */
export function OrderForm({ products, errorMessage, onSubmit }: OrderFormProps) {
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [customerEmail, setCustomerEmail] = useState("");

  // Until the visitor picks a product, the first option of the select is the effective choice.
  const selectedProductId = products.some((product) => product.id === productId)
    ? productId
    : (products[0]?.id ?? "");

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit({
      productId: selectedProductId,
      quantity: Number(quantity),
      customerEmail,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        <label htmlFor={PRODUCT_FIELD_ID}>Product</label>
        <ProductSelect
          id={PRODUCT_FIELD_ID}
          products={products}
          value={selectedProductId}
          onChange={setProductId}
        />
      </p>
      <p>
        <label htmlFor={QUANTITY_FIELD_ID}>Quantity</label>
        <input
          id={QUANTITY_FIELD_ID}
          name="quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </p>
      <p>
        <label htmlFor={EMAIL_FIELD_ID}>Email</label>
        <input
          id={EMAIL_FIELD_ID}
          name="customerEmail"
          type="email"
          required
          value={customerEmail}
          onChange={(event) => setCustomerEmail(event.target.value)}
        />
      </p>
      {errorMessage === null ? null : <p role="alert">{errorMessage}</p>}
      <p>
        <button type="submit">Place order</button>
      </p>
    </form>
  );
}
