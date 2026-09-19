import type {
  DeliverPendingNotificationsUseCase,
  DeliveryOutcome,
} from "../ports/in/deliver-pending-notifications.js";
import type { NotificationOutbox } from "../ports/out/notification-outbox.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";

/** Default batch size of one relay run. */
export const DEFAULT_PENDING_BATCH_SIZE = 50;

/**
 * One relay pass: read the `PENDING` intents and retry each of them through the notification port
 * with its own idempotency key. Successful intents become `SENT`, failed intents stay `PENDING` with
 * an incremented attempt count and are picked up by the next pass. Intents are never deleted, and
 * the provider deduplicates by key, so retries and restarts yield exactly one
 * `ORDER_CONFIRMATION` per order.
 */
export class DeliverPendingNotifications implements DeliverPendingNotificationsUseCase {
  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly dispatcher: NotificationDispatcher,
    private readonly batchSize: number = DEFAULT_PENDING_BATCH_SIZE,
  ) {}

  async execute(): Promise<DeliveryOutcome> {
    const pending = await this.outbox.listPending(this.batchSize);
    const delivered: string[] = [];
    const failed: string[] = [];

    for (const intent of pending) {
      try {
        await this.dispatcher.dispatch(intent);
        delivered.push(intent.id);
      } catch {
        failed.push(intent.id);
      }
    }

    return { delivered, failed };
  }
}
