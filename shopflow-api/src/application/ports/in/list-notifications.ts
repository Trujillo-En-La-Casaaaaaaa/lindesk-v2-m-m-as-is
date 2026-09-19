import type { NotificationRecord } from "../../../domain/notification.js";

/**
 * Inbound port: list notification records in insertion order.
 * Reads through the outbound notification port, so the API returns exactly what the provider stored.
 */
export interface ListNotificationsUseCase {
  execute(): Promise<NotificationRecord[]>;
}
