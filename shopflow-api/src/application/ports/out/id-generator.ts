import { randomUUID } from "node:crypto";

/**
 * Identifier port: keeps uuid v4 generation replaceable in tests while production keeps the legacy
 * `randomUUID()` semantics for order ids and outbox (idempotency) ids.
 */
export interface IdGenerator {
  nextId(): string;
}

export class UuidIdGenerator implements IdGenerator {
  nextId(): string {
    return randomUUID();
  }
}
