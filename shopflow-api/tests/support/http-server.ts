import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../../src/adapters/inbound/http/server.js";
import type { HttpUseCases } from "../../src/adapters/inbound/http/controllers.js";

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Starts the real Express adapter on an ephemeral port so HTTP tests exercise the actual routing,
 * parsing and error mapping over the wire instead of calling handlers directly.
 */
export async function startHttpServer(useCases: HttpUseCases): Promise<TestServer> {
  const app = createApp({ useCases });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * Base URL of the composed stack under test.
 *
 * `API_BASE_URL` wins when set; the handoff's `BASE_URL` is accepted as well, but only when it is an
 * absolute http(s) URL - Vitest/Vite overwrite `BASE_URL` with their own "/" default, so a bare "/"
 * must never be mistaken for a live server.
 */
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of [
    env.SHOPFLOW_API_BASE_URL,
    env.API_BASE_URL,
    env.SHOPFLOW_API_URL,
    env.BASE_URL,
  ]) {
    const value = candidate?.trim();
    if (value !== undefined && /^https?:\/\/[^\s]+$/.test(value)) {
      return value.replace(/\/+$/, "");
    }
  }
  return null;
}

/** Base URL of the notification provider (`PROVIDER_URL`, falling back to `NOTIFICATION_PROVIDER_URL`). */
export function resolveProviderUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of [env.PROVIDER_URL, env.NOTIFICATION_PROVIDER_URL]) {
    const value = candidate?.trim();
    if (value !== undefined && /^https?:\/\/[^\s]+$/.test(value)) {
      return value.replace(/\/+$/, "");
    }
  }
  return null;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  text: string;
}

/** Minimal HTTP client used by the contract and characterization suites. */
export async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

export function postJson(baseUrl: string, path: string, body: unknown): Promise<HttpResponse> {
  return request(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
