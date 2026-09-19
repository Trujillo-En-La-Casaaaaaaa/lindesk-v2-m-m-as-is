import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProducts } from "../api/client";
import { toErrorMessage } from "../api/errors";
import type { Product } from "../api/types";
import { ProductTable } from "../components/ProductTable";

/** `GET /` - "ShopFlow Catalog": every product with a `View` link and a "Create order" link. */
export function CatalogRoute() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
          setErrorMessage(toErrorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section>
      <h1>ShopFlow Catalog</h1>
      {errorMessage === null ? null : <p role="alert">{errorMessage}</p>}
      {products === null ? (errorMessage === null ? <p>Loading&hellip;</p> : null) : null}
      {products === null ? null : <ProductTable products={products} />}
      <p>
        <Link to="/orders/new">Create order</Link>
      </p>
    </section>
  );
}
