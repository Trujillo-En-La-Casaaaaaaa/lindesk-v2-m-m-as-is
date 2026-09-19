import type { NotificationRecord } from "../../domain/notification.js";
import type { ListNotificationsUseCase } from "../ports/in/list-notifications.js";
import type { NotificationPort } from "../ports/out/notification-port.js";

/**
 * Notification history. It is read through the outbound notification port (the provider owns the
 * storage), so the API returns the same records in the same insertion order as the legacy log.
 */
export class ListNotifications implements ListNotificationsUseCase {
  constructor(private readonly notifications: NotificationPort) {}

  execute(): Promise<NotificationRecord[]> {
    return this.notifications.list();
  }
}
