import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProduct } from "../api/client";
import { isNotFoundError, toErrorMessage } from "../api/errors";
import type { Product } from "../api/types";

/** `GET /products/:id` - the product name, its `priceCents` and its `stock`; `Not found` on 404. */
export function ProductRoute() {
  const { id = "" } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setProduct(null);
    setNotFound(false);
    setErrorMessage(null);
    getProduct(id)
      .then((loaded) => {
        if (active) {
          setProduct(loaded);
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

  // The legacy product page answered an unknown id with the body text `Not found`.
  if (notFound) {
    return <p>Not found</p>;
  }

  return (
    <section>
      {product === null ? null : (
        <>
          <h1>{product.name}</h1>
          <p>ID: {product.id}</p>
          <p>Price: {product.priceCents} cents</p>
          <p>Stock: {product.stock}</p>
        </>
      )}
      {errorMessage === null ? null : <p role="alert">{errorMessage}</p>}
      {product === null && errorMessage === null ? <p>Loading&hellip;</p> : null}
      <p>
        <Link to="/">Back</Link>
      </p>
    </section>
  );
}
