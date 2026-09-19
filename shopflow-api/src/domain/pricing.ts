/**
 * Pricing rule kept from the monolith: integer cents, no currency, tax, discount or rounding.
 * `totalCents` is the product price at order time multiplied by the ordered quantity.
 */
export function computeTotalCents(priceCents: number, quantity: number): number {
  return priceCents * quantity;
}
