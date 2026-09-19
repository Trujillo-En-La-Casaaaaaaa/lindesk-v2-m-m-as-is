/**
 * Domain/application errors.
 *
 * Each error carries a semantic `kind` that the inbound HTTP adapter maps to a status code
 * (`VALIDATION` -> 400, `NOT_FOUND` -> 404, `CONFLICT` -> 400, `UNEXPECTED` -> 500) plus the
 * preserved, customer-visible message. Messages live here or in the use cases, never in the
 * Express layer.
 */
export type DomainErrorKind = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "UNEXPECTED";

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind, message: string) {
    super(message);
    this.name = "DomainError";
    this.kind = kind;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** `400 {"error":"Invalid order"}` - input validation, before any database access. */
export function invalidOrder(): DomainError {
  return new DomainError("VALIDATION", "Invalid order");
}

/** `404 {"error":"Product not found"}`. */
export function productNotFound(): DomainError {
  return new DomainError("NOT_FOUND", "Product not found");
}

/** `400 {"error":"Insufficient stock"}` - the conditional decrement matched no row. */
export function insufficientStock(): DomainError {
  return new DomainError("CONFLICT", "Insufficient stock");
}

/** `400 {"error":"Cannot ship order"}` - unknown order or a status other than `CONFIRMED`. */
export function cannotShipOrder(): DomainError {
  return new DomainError("CONFLICT", "Cannot ship order");
}

/** `404 {"error":"Not found"}` - generic single-resource read miss. */
export function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "Not found");
}
