import { API_BASE } from "../config/runtime";
import { ApiError, GENERIC_ERROR_MESSAGE } from "./errors";
import type { CreateOrderRequest, Order, Product } from "./types";

/**
 * The only five API calls this repository makes, all through the same origin (`API_BASE`, `/api` by
 * default). A non-2xx response becomes an `ApiError` carrying the response's `error` message so the
 * views can display it verbatim; no business rule is applied here.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" }, ...init });
  } catch {
    // The request never reached the API: there is no message to display.
    throw new ApiError(0, GENERIC_ERROR_MESSAGE);
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response));
  }

  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const message = (body as { error?: unknown }).error;
      if (typeof message === "string" && message.trim() !== "") {
        return message;
      }
    }
  } catch {
    // Not a JSON body: fall through to the generic message.
  }
  return GENERIC_ERROR_MESSAGE;
}

/** `GET /api/products` - the catalog, as ordered by the API. */
export function listProducts(): Promise<Product[]> {
  return request<Product[]>("/products");
}

/** `GET /api/products/:id` - `404 {"error":"Not found"}` for an unknown id. */
export function getProduct(id: string): Promise<Product> {
  return request<Product>(`/products/${encodeURIComponent(id)}`);
}

/** `POST /api/orders` - `201` with the created order. */
export function createOrder(input: CreateOrderRequest): Promise<Order> {
  return request<Order>("/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** `GET /api/orders/:id` - `404 {"error":"Not found"}` for an unknown id. */
export function getOrder(id: string): Promise<Order> {
  return request<Order>(`/orders/${encodeURIComponent(id)}`);
}

/** `POST /api/orders/:id/ship` - guarded transition; `400 {"error":"Cannot ship order"}` otherwise. */
export function shipOrder(id: string): Promise<Order> {
  return request<Order>(`/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
}
