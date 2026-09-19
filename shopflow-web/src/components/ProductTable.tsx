import { Link } from "react-router-dom";
import type { Product } from "../api/types";

export interface ProductTableProps {
  products: Product[];
}

/**
 * Catalog table: the legacy columns (ID / Name / Price / Stock) with one `View` link per product.
 * The price keeps the legacy rendering `<priceCents> cents`.
 */
export function ProductTable({ products }: ProductTableProps) {
  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Price</th>
          <th>Stock</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {products.map((product) => (
          <tr key={product.id}>
            <td>{product.id}</td>
            <td>{product.name}</td>
            <td>{product.priceCents} cents</td>
            <td>{product.stock}</td>
            <td>
              <Link to={`/products/${encodeURIComponent(product.id)}`}>View</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
