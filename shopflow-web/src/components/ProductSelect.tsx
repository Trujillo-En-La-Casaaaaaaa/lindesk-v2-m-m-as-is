import type { Product } from "../api/types";

export interface ProductSelectProps {
  id: string;
  products: Product[];
  value: string;
  onChange: (productId: string) => void;
}

/** Product picker of the order form; every option is labelled `<name> (stock <stock>)`. */
export function ProductSelect({ id, products, value, onChange }: ProductSelectProps) {
  return (
    <select id={id} name="productId" value={value} onChange={(event) => onChange(event.target.value)}>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {`${product.name} (stock ${product.stock})`}
        </option>
      ))}
    </select>
  );
}
