import type { IncomingMessage, ServerResponse } from "node:http";

import type { NotificationStore, SubmitRequest } from "./store.js";

/** Only this notification type exists in the preserved system. */
export const SUPPORTED_TYPE = "ORDER_CONFIRMATION";

/** Request bodies larger than this are rejected instead of being buffered without limit. */
export const MAX_BODY_BYTES = 64 * 1024;

export const INVALID_NOTIFICATION = { error: "Invalid notification" } as const;
export const STORAGE_FAILURE = { error: "Storage failure" } as const;
export const NOT_FOUND = { error: "Not found" } as const;

/**
 * Routes of the emulated provider, exactly as `contracts/notification-provider-api.md` defines them:
 *
 *   GET  /health         -> 200 {"ok":true}
 *   GET  /notifications  -> 200 all records in append order
 *   POST /notifications  -> 201 created | 200 repeated key | 400 invalid | 500 storage failure
 */
export function createRequestHandler(
  store: NotificationStore,
): (request: IncomingMessage, response: ServerResponse) => void {
  return function handleRequest(request, response): void {
    void route(store, request, response);
  };
}

async function route(
  store: NotificationStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const { pathname } = new URL(request.url ?? "/", "http://notification-provider");

  if (method === "GET" && pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/notifications") {
    sendJson(response, 200, store.list());
    return;
  }
  if (method === "POST" && pathname === "/notifications") {
    await submitNotification(store, request, response);
    return;
  }
  sendJson(response, 404, NOT_FOUND);
}

async function submitNotification(
  store: NotificationStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    sendJson(response, 400, INVALID_NOTIFICATION);
    return;
  }

  const parsed = parseSubmitRequest(body);
  if (parsed === null) {
    sendJson(response, 400, INVALID_NOTIFICATION);
    return;
  }

  try {
    const result = await store.submit(parsed);
    sendJson(response, result.created ? 201 : 200, result.record);
  } catch {
    sendJson(response, 500, STORAGE_FAILURE);
  }
}

/** Structural validation of the submit body; `null` means `400 Invalid notification`. */
export function parseSubmitRequest(body: unknown): SubmitRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  const { idempotencyKey, type, orderId, payload } = candidate;

  if (!isNonEmptyString(idempotencyKey)) {
    return null;
  }
  if (type !== SUPPORTED_TYPE) {
    return null;
  }
  if (!isNonEmptyString(orderId)) {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  return {
    idempotencyKey,
    type,
    orderId,
    payload: payload as Record<string, unknown>,
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
