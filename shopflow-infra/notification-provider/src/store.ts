import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The notification record: byte-for-byte the shape the monolith appended to its JSONL log
 * (`{id, type, orderId, createdAt, payload}`). The idempotency key is deliberately *not* part of it -
 * it lives in a separate sidecar file so `GET /notifications` keeps the legacy shape.
 */
export interface NotificationRecord {
  id: string;
  type: string;
  orderId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface SubmitRequest {
  idempotencyKey: string;
  type: string;
  orderId: string;
  payload: Record<string, unknown>;
}

export interface SubmitResult {
  record: NotificationRecord;
  /** `true` when this call appended the record, `false` when the key was already known. */
  created: boolean;
}

export interface StorePaths {
  logPath: string;
  idempotencyPath: string;
}

/** Injectable clock so tests can pin `createdAt`. */
export interface Clock {
  nowIso(): string;
}

/** ISO-8601 UTC with milliseconds, as the monolith produced it. */
export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

/**
 * Append-only, single-writer JSONL store.
 *
 * - `init()` creates the files (and their parent directory) when absent and loads both files into
 *   memory, so a restarted process keeps serving everything it recorded before.
 * - `submit()` is idempotent per key: the first submission appends, every later one returns the
 *   stored record untouched.
 * - Appends go through one promise queue, so concurrent requests can never interleave partial
 *   lines, and each append is flushed (`fsync`) before the caller is told about it - a client that
 *   received `201` can immediately read the record back.
 */
export class NotificationStore {
  private readonly records: NotificationRecord[] = [];
  private readonly recordById = new Map<string, NotificationRecord>();
  private readonly keyToRecordId = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: StorePaths,
    private readonly clock: Clock = systemClock,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** Create the store files when absent and load the existing JSONL content into memory. */
  async init(): Promise<void> {
    for (const path of [this.paths.logPath, this.paths.idempotencyPath]) {
      await mkdir(dirname(path), { recursive: true });
      if (!existsSync(path)) {
        const handle = await open(path, "a");
        await handle.close();
      }
    }

    for (const line of parseJsonl(await readFile(this.paths.logPath, "utf8"))) {
      const record = asNotificationRecord(line);
      if (record === null) {
        continue;
      }
      this.records.push(record);
      this.recordById.set(record.id, record);
    }

    for (const line of parseJsonl(await readFile(this.paths.idempotencyPath, "utf8"))) {
      const key = typeof line.key === "string" ? line.key : null;
      const recordId = typeof line.recordId === "string" ? line.recordId : null;
      if (key !== null && recordId !== null && this.recordById.has(recordId)) {
        this.keyToRecordId.set(key, recordId);
      }
    }
  }

  /** Every record in append order (oldest first). */
  list(): NotificationRecord[] {
    return this.records.map(cloneRecord);
  }

  /** Number of stored records; used by the tests. */
  get size(): number {
    return this.records.length;
  }

  /**
   * Store one notification intent. Repeated submissions of the same idempotency key return the
   * existing record with `created: false` and append nothing.
   */
  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const known = this.existingResult(request.idempotencyKey);
    if (known !== null) {
      return known;
    }

    return this.enqueue(async () => {
      // Re-check inside the writer queue: two concurrent submits of the same key must append once.
      const raced = this.existingResult(request.idempotencyKey);
      if (raced !== null) {
        return raced;
      }

      const record: NotificationRecord = {
        id: this.newId(),
        type: request.type,
        orderId: request.orderId,
        createdAt: this.clock.nowIso(),
        payload: { ...request.payload, orderId: request.orderId },
      };

      await appendJsonLine(this.paths.logPath, record);
      await appendJsonLine(this.paths.idempotencyPath, {
        key: request.idempotencyKey,
        recordId: record.id,
      });

      this.records.push(record);
      this.recordById.set(record.id, record);
      this.keyToRecordId.set(request.idempotencyKey, record.id);
      return { record: cloneRecord(record), created: true };
    });
  }

  private existingResult(idempotencyKey: string): SubmitResult | null {
    const recordId = this.keyToRecordId.get(idempotencyKey);
    if (recordId === undefined) {
      return null;
    }
    const record = this.recordById.get(recordId);
    if (record === undefined) {
      return null;
    }
    return { record: cloneRecord(record), created: false };
  }

  /** One in-process writer queue: appends are serialized, never interleaved. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(noop, noop);
    return run;
  }
}

function noop(): void {
  // deliberately empty
}

function cloneRecord(record: NotificationRecord): NotificationRecord {
  return { ...record, payload: { ...record.payload } };
}

function asNotificationRecord(value: Record<string, unknown>): NotificationRecord | null {
  const { id, type, orderId, createdAt, payload } = value;
  if (
    typeof id !== "string" ||
    typeof type !== "string" ||
    typeof orderId !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return { id, type, orderId, createdAt, payload: payload as Record<string, unknown> };
}

function parseJsonl(contents: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A torn trailing line must never stop the service from starting.
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed.push(value as Record<string, unknown>);
    }
  }
  return parsed;
}

/** Append one JSON object as a line and fsync it before returning. */
async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
