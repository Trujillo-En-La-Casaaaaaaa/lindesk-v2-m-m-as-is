import { DomainError } from "../../../domain/errors.js";
import type { DomainErrorKind } from "../../../domain/errors.js";

export interface ErrorResponse {
  status: number;
  body: { error: string };
}

/** Domain kind -> HTTP status. Messages are never rewritten here. */
const STATUS_BY_KIND: Readonly<Record<DomainErrorKind, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 400,
  UNEXPECTED: 500,
};

/**
 * Error mapping preserved from the monolith (`status = error.status ?? 500`,
 * body `{"error": message ?? "Internal error"}`):
 *
 * - domain errors map through their semantic kind (400/404/400/500) and keep their exact message;
 * - errors that already carry an HTTP status (for example Express body-parser failures) keep it;
 * - anything else is `500` with the error message, falling back to `Internal error`.
 */
export function mapErrorToResponse(error: unknown): ErrorResponse {
  if (error instanceof DomainError) {
    return {
      status: STATUS_BY_KIND[error.kind] ?? 500,
      body: { error: error.message },
    };
  }

  const httpStatus = extractHttpStatus(error);
  if (httpStatus !== null) {
    return { status: httpStatus, body: { error: messageOf(error) ?? "Internal error" } };
  }

  return { status: 500, body: { error: messageOf(error) ?? "Internal error" } };
}

function messageOf(error: unknown): string | null {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message !== ""
  ) {
    return (error as { message: string }).message;
  }
  return null;
}

function extractHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  for (const key of ["status", "statusCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return null;
}
