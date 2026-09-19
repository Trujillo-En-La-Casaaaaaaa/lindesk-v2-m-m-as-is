/**
 * Error handling shared by the API client and the views.
 *
 * The API answers every failure with `{"error":"<message>"}`; views display that message verbatim.
 * When a response carries no usable message (or the request never reached the API), the legacy
 * generic text is used instead.
 */

/** Legacy generic text used when the API response carries no `error` message. */
export const GENERIC_ERROR_MESSAGE = "Unexpected error";

/** A non-2xx response (or a transport failure, with status `0`) turned into a displayable error. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string = GENERIC_ERROR_MESSAGE) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  /** `true` for the API's `404 {"error":"Not found"}` answers. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** `true` when the failure was the API's `404 Not found`. */
export function isNotFoundError(value: unknown): boolean {
  return isApiError(value) && value.isNotFound;
}

/** The text a view may display for any thrown value. */
export function toErrorMessage(value: unknown): string {
  if (isApiError(value)) {
    return value.message;
  }
  if (value instanceof Error && value.message !== "") {
    return value.message;
  }
  return GENERIC_ERROR_MESSAGE;
}
