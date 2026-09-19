/**
 * Time port: keeps values replaceable in tests while production uses the system clock.
 * `nowIso()` is the ISO-8601 UTC timestamp with milliseconds used for `orders.created_at` and
 * notification `createdAt`.
 */
export interface Clock {
  now(): Date;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowIso(): string {
    return this.now().toISOString();
  }
}
