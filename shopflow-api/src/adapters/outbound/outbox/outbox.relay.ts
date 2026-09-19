import type { DeliverPendingNotificationsUseCase } from "../../../application/ports/in/deliver-pending-notifications.js";
import type { DeliveryOutcome } from "../../../application/ports/in/deliver-pending-notifications.js";

/** Minimal logging surface so the relay stays testable. */
export interface RelayLogger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Background delivery relay. It runs once on startup and then every `intervalMs`, retrying every
 * `PENDING` outbox intent through the notification port with its idempotency key.
 *
 * Intents are never deleted: a successful delivery is marked `SENT`, a failed one stays `PENDING`
 * with an incremented attempt count and is retried on the next pass. Relay failures are logged, never
 * thrown, so an unavailable provider or database cannot take the API process down.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deliverPending: DeliverPendingNotificationsUseCase,
    private readonly intervalMs: number,
    private readonly logger: RelayLogger = console,
  ) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Start the relay: one immediate pass plus a repeating pass every `intervalMs`. */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // A pending relay timer must not keep the process alive on shutdown.
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One relay pass. Returns `null` when a pass was skipped (already running) or failed entirely. */
  async runOnce(): Promise<DeliveryOutcome | null> {
    if (this.running) {
      return null;
    }
    this.running = true;
    try {
      const outcome = await this.deliverPending.execute();
      if (outcome.delivered.length > 0) {
        this.logger.info(`outbox relay: delivered ${outcome.delivered.length} notification(s)`);
      }
      if (outcome.failed.length > 0) {
        this.logger.error(
          `outbox relay: delivery failed for ${outcome.failed.length} intent(s), still PENDING: ${outcome.failed.join(", ")}`,
        );
      }
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`outbox relay: run failed: ${message}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
