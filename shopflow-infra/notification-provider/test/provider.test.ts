import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createRequestHandler } from "../src/http-app.js";
import { NotificationStore, type StorePaths } from "../src/store.js";

/**
 * Contract tests for the emulated notification provider (owner: shopflow-infra).
 *
 * They run the real HTTP surface (in process, and once as a real child process for the restart case)
 * over a throwaway JSONL store, so idempotency, append ordering, flush-before-response and
 * persistence across a restart are exercised for real - never mocked.
 */

const SERVER_ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const RECORD_KEYS = ["createdAt", "id", "orderId", "payload", "type"];
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ProviderResponse {
  status: number;
  body: unknown;
}

interface RunningProvider {
  baseUrl: string;
  stop(): Promise<void>;
}

function temporaryPaths(dir: string): StorePaths {
  return {
    logPath: join(dir, "notifications.jsonl"),
    idempotencyPath: join(dir, "notifications.idempotency.jsonl"),
  };
}

async function withStore(
  run: (provider: RunningProvider, paths: StorePaths) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shopflow-provider-"));
  const paths = temporaryPaths(dir);
  const provider = await startInProcess(paths);
  try {
    await run(provider, paths);
  } finally {
    await provider.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function startInProcess(paths: StorePaths): Promise<RunningProvider> {
  const store = new NotificationStore(paths);
  await store.init();
  const server = createHttpServer(createRequestHandler(store));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

/** Start the compiled entry point as a real child process, exactly as the container does. */
async function startProcess(paths: StorePaths): Promise<RunningProvider> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      NOTIFICATION_LOG_PATH: paths.logPath,
      NOTIFICATION_IDEMPOTENCY_PATH: paths.idempotencyPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, 20_000);
  } catch (error) {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
    throw new Error(`${String(error)}\nprovider output:\n${output.join("")}`);
  }

  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP address");
  const port = address.port;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      await response.arrayBuffer();
      if (response.status === 200) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`provider did not become healthy within ${timeoutMs} ms (${lastError})`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function send(baseUrl: string, path: string, init?: RequestInit): Promise<ProviderResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

function post(baseUrl: string, body: unknown): Promise<ProviderResponse> {
  return send(baseUrl, "/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function submitBody(orderId: string, idempotencyKey: string, customerEmail: string): unknown {
  return {
    idempotencyKey,
    type: "ORDER_CONFIRMATION",
    orderId,
    payload: { customerEmail, orderId },
  };
}

async function list(baseUrl: string): Promise<unknown[]> {
  const response = await send(baseUrl, "/notifications");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body), "GET /notifications must answer a JSON array");
  return response.body as unknown[];
}

async function jsonl(path: string): Promise<unknown[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("notification provider emulator", () => {
  it('GET /health answers 200 {"ok":true}', () =>
    withStore(async ({ baseUrl }) => {
      const response = await send(baseUrl, "/health");
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
    }));

  it("the first POST /notifications answers 201 with the exact record shape and is readable immediately", () =>
    withStore(async ({ baseUrl }, paths) => {
      const orderId = randomUUID();
      const idempotencyKey = randomUUID();

      const created = await post(
        baseUrl,
        submitBody(orderId, idempotencyKey, "first@example.com"),
      );

      assert.equal(created.status, 201);
      const record = created.body as Record<string, unknown>;
      assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
      assert.equal(record.type, "ORDER_CONFIRMATION");
      assert.equal(record.orderId, orderId);
      assert.match(String(record.id), UUID_V4);
      assert.match(String(record.createdAt), ISO_MILLIS);
      assert.deepEqual(record.payload, { customerEmail: "first@example.com", orderId });
      assert.equal(Object.hasOwn(record, "idempotencyKey"), false);

      // Flushed before the response was written: a client holding the 201 can read it back now.
      assert.deepEqual(await list(baseUrl), [record]);
      assert.deepEqual(await jsonl(paths.logPath), [record]);
      assert.deepEqual(await jsonl(paths.idempotencyPath), [
        { key: idempotencyKey, recordId: record.id },
      ]);
    }));

  it("ensures payload.orderId is present even when the caller omits it", () =>
    withStore(async ({ baseUrl }) => {
      const orderId = randomUUID();
      const created = await post(baseUrl, {
        idempotencyKey: randomUUID(),
        type: "ORDER_CONFIRMATION",
        orderId,
        payload: { customerEmail: "no-order-id-in-payload@example.com" },
      });

      assert.equal(created.status, 201);
      assert.deepEqual((created.body as Record<string, unknown>).payload, {
        customerEmail: "no-order-id-in-payload@example.com",
        orderId,
      });
    }));

  it("answers 200 with the existing record for a repeated idempotency key and appends nothing", () =>
    withStore(async ({ baseUrl }, paths) => {
      const orderId = randomUUID();
      const idempotencyKey = randomUUID();
      const body = submitBody(orderId, idempotencyKey, "duplicate@example.com");

      const first = await post(baseUrl, body);
      const second = await post(baseUrl, body);
      const third = await post(baseUrl, body);

      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(third.status, 200);
      assert.deepEqual(second.body, first.body);
      assert.deepEqual(third.body, first.body);

      assert.deepEqual(await list(baseUrl), [first.body]);
      assert.deepEqual(await jsonl(paths.logPath), [first.body]);
    }));

  it("stores a second record when the caller uses a different key for the same order", () =>
    withStore(async ({ baseUrl }) => {
      const orderId = randomUUID();

      const first = await post(baseUrl, submitBody(orderId, randomUUID(), "k1@example.com"));
      const second = await post(baseUrl, submitBody(orderId, randomUUID(), "k2@example.com"));

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.notEqual(
        (first.body as Record<string, unknown>).id,
        (second.body as Record<string, unknown>).id,
      );
      assert.equal((await list(baseUrl)).length, 2);
    }));

  it("rejects invalid submissions with 400 Invalid notification and appends nothing", () =>
    withStore(async ({ baseUrl }, paths) => {
      const orderId = randomUUID();
      const invalidBodies: unknown[] = [
        { type: "ORDER_CONFIRMATION", orderId, payload: {} },
        { idempotencyKey: randomUUID(), type: "ORDER_CONFIRMATION", payload: {} },
        { idempotencyKey: randomUUID(), orderId, payload: {} },
        { idempotencyKey: randomUUID(), type: "ORDER_CANCELLATION", orderId, payload: {} },
        { idempotencyKey: "   ", type: "ORDER_CONFIRMATION", orderId, payload: {} },
        { idempotencyKey: randomUUID(), type: "ORDER_CONFIRMATION", orderId: 42, payload: {} },
        {
          idempotencyKey: randomUUID(),
          type: "ORDER_CONFIRMATION",
          orderId,
          payload: "not-an-object",
        },
        { idempotencyKey: randomUUID(), type: "ORDER_CONFIRMATION", orderId, payload: null },
        "not-an-object",
        [1, 2, 3],
      ];

      for (const body of invalidBodies) {
        const response = await post(baseUrl, body);
        assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        assert.deepEqual(response.body, { error: "Invalid notification" });
      }

      const malformedJson = await send(baseUrl, "/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      assert.equal(malformedJson.status, 400);
      assert.deepEqual(malformedJson.body, { error: "Invalid notification" });

      assert.deepEqual(await list(baseUrl), []);
      assert.equal((await readFile(paths.logPath, "utf8")), "");
      assert.equal((await readFile(paths.idempotencyPath, "utf8")), "");
    }));

  it("keeps previously recorded notifications when the process restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shopflow-provider-restart-"));
    const paths = temporaryPaths(dir);
    const orderId = randomUUID();
    const idempotencyKey = randomUUID();
    const body = submitBody(orderId, idempotencyKey, "restart@example.com");

    let created: ProviderResponse | null = null;
    const first = await startProcess(paths);
    try {
      created = await post(first.baseUrl, body);
      assert.equal(created.status, 201);
      assert.deepEqual(await list(first.baseUrl), [created.body]);
    } finally {
      await first.stop();
    }

    const restarted = await startProcess(paths);
    try {
      assert.deepEqual(await list(restarted.baseUrl), [created.body]);

      // The idempotency sidecar survived the restart too, so the retry stays a 200 with no duplicate.
      const repeated = await post(restarted.baseUrl, body);
      assert.equal(repeated.status, 200);
      assert.deepEqual(repeated.body, created.body);
      assert.equal((await list(restarted.baseUrl)).length, 1);
    } finally {
      await restarted.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends exactly one record when the same key is submitted concurrently", () =>
    withStore(async ({ baseUrl }, paths) => {
      const orderId = randomUUID();
      const idempotencyKey = randomUUID();
      const body = submitBody(orderId, idempotencyKey, "concurrent-same-key@example.com");

      const responses = await Promise.all(Array.from({ length: 5 }, () => post(baseUrl, body)));
      const statuses = responses.map((response) => response.status).sort();
      assert.deepEqual(statuses, [200, 200, 200, 200, 201]);

      const records = await list(baseUrl);
      assert.equal(records.length, 1);
      for (const response of responses) {
        assert.deepEqual(response.body, records[0]);
      }
      assert.equal((await jsonl(paths.logPath)).length, 1);
    }));

  it("serializes concurrent appends so no JSONL line is ever interleaved", () =>
    withStore(async ({ baseUrl }, paths) => {
      const orderId = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 25 }, () =>
          post(baseUrl, submitBody(orderId, randomUUID(), "concurrent-many@example.com")),
        ),
      );
      for (const response of responses) {
        assert.equal(response.status, 201);
      }

      const records = await list(baseUrl);
      assert.equal(records.length, 25);
      assert.equal(new Set(records.map((record) => (record as { id: string }).id)).size, 25);

      const lines = await jsonl(paths.logPath);
      assert.equal(lines.length, 25);
      assert.equal(new Set(lines.map((line) => (line as { id: string }).id)).size, 25);
    }));

  it("answers 404 for any other route", () =>
    withStore(async ({ baseUrl }) => {
      const response = await send(baseUrl, "/something-else");
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: "Not found" });
    }));

  it("serves notifications without opening any outbound network connection", () =>
    withStore(async ({ baseUrl }) => {
      const outbound: string[] = [];
      const originalConnect = net.Socket.prototype.connect;

      net.Socket.prototype.connect = function patchedConnect(
        this: net.Socket,
        ...args: unknown[]
      ): net.Socket {
        const target = describeConnectTarget(args);
        if (target !== null && !isLoopback(target.host)) {
          outbound.push(`${target.host}:${target.port}`);
        }
        const original = originalConnect as unknown as (
          this: net.Socket,
          ...rest: unknown[]
        ) => net.Socket;
        return original.apply(this, args);
      } as unknown as typeof net.Socket.prototype.connect;

      try {
        const orderId = randomUUID();
        const created = await post(
          baseUrl,
          submitBody(orderId, randomUUID(), "offline@example.com"),
        );
        assert.equal(created.status, 201);
        assert.equal((await list(baseUrl)).length, 1);
      } finally {
        net.Socket.prototype.connect = originalConnect;
      }

      assert.deepEqual(outbound, [], "the emulator must never call out to the network");
    }));

  it("has no runtime dependency and imports only node: built-ins", async () => {
    const root = await findPackageRoot();
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.deepEqual(manifest.dependencies ?? {}, {}, "no external runtime dependency is allowed");
    assert.ok(
      Object.keys(manifest.devDependencies ?? {}).length > 0,
      "the build toolchain is a devDependency",
    );

    const sources = [
      ...(await listFiles(join(root, "src"))),
      ...(await listFiles(join(root, "dist", "src"))),
    ];
    assert.ok(sources.length > 0, "expected provider sources to scan");

    for (const file of sources) {
      const contents = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(contents)) {
        assert.ok(
          specifier.startsWith("node:") || specifier.startsWith("."),
          `${file} imports "${specifier}" - only node: built-ins and relative modules are allowed`,
        );
      }
      assert.equal(/\bfetch\s*\(/.test(contents), false, `${file} must not perform HTTP calls`);
      assert.equal(
        /\bhttps?\.(?:request|get)\s*\(/.test(contents),
        false,
        `${file} must not use an HTTP client`,
      );
      assert.equal(
        /\b(?:net\.createConnection|dns\.lookup|dnsPromises\.)/.test(contents),
        false,
        `${file} must not open outbound sockets`,
      );
    }
  });
});

function describeConnectTarget(args: unknown[]): { host: string; port: number } | null {
  const [first, second] = args;
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === "string") {
      return null; // unix socket or Windows named pipe
    }
    const host =
      typeof options.host === "string"
        ? options.host
        : typeof options.hostname === "string"
          ? options.hostname
          : "localhost";
    return { host, port: typeof options.port === "number" ? options.port : -1 };
  }
  if (typeof first === "number") {
    return { host: typeof second === "string" ? second : "localhost", port: first };
  }
  return null;
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  );
}

function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function findPackageRoot(): Promise<string> {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let level = 0; level < 5; level += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (manifest.name === "shopflow-notification-provider") {
        return dir;
      }
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the notification-provider package root");
}
