/**
 * Runtime configuration of this repository.
 *
 * The only configurable value is the same-origin base path of the frozen JSON API. There is
 * deliberately no host, credential, service-discovery or database configuration here: the browser
 * only ever calls `/api/*` on the origin that served the SPA, and nginx forwards that prefix to the
 * `api` service.
 */

/** Documented default from `.env.example`; also the value used when `VITE_API_BASE` is unset. */
export const DEFAULT_API_BASE = "/api";

/**
 * Normalises the configured base path: blank values fall back to `/api` and a trailing slash is
 * dropped so paths can be appended with a single separator.
 */
export function resolveApiBase(configured: string | undefined): string {
  const trimmed = (configured ?? "").trim();
  if (trimmed === "") {
    return DEFAULT_API_BASE;
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** Base path used by every API call. `/api` unless `VITE_API_BASE` overrides it. */
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE);
