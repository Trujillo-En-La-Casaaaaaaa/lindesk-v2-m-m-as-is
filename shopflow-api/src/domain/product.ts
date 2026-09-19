/**
 * Product aggregate data owned by this service (table `products`, schema owned by shopflow-infra).
 */
export interface Product {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}
