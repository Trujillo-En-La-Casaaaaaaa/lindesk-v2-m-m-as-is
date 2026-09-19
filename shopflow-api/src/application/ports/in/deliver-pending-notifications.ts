/**
 * Inbound port used by the outbox relay: retry every `PENDING` delivery intent once and report the
 * outcome. Intents are never deleted; a failed intent stays `PENDING` with an incremented attempt
 * count so a later run can retry it with the same idempotency key.
 */
export interface DeliverPendingNotificationsUseCase {
  execute(): Promise<DeliveryOutcome>;
}

export interface DeliveryOutcome {
  /** Ids of the intents delivered (and marked `SENT`) by this run. */
  delivered: string[];
  /** Ids of the intents that could not be delivered; they stay `PENDING`. */
  failed: string[];
}
