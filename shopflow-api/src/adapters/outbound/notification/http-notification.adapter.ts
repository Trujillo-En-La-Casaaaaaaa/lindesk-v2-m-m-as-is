import type { NotificationPort } from "../../../application/ports/out/notification-port.js";
import type {
  NotificationDeliveryRequest,
  NotificationRecord,
} from "../../../domain/notification.js";

/**
 * HTTP adapter for the notification provider owned by shopflow-infra.
 *
 * `POST {base}/notifications` with `{idempotencyKey, type, orderId, payload}`; `201` (created) and
 * `200` (already existing for that key) both count as delivered, so a retry never produces a second
 * record. `GET {base}/notifications` returns the records in append order. The idempotency key is the
 * outbox row id.
 */
export class HttpNotificationAdapter implements NotificationPort {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  }

  async submit(notification: NotificationDeliveryRequest): Promise<NotificationRecord> {
    const response = await this.request(`${this.baseUrl}/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: notification.idempotencyKey,
        type: notification.type,
        orderId: notification.orderId,
        payload: notification.payload,
      }),
    });

    if (response.status !== 201 && response.status !== 200) {
      throw new Error(await failureMessage(response, "rejected the notification"));
    }

    return (await response.json()) as NotificationRecord;
  }

  async list(): Promise<NotificationRecord[]> {
    const response = await this.request(`${this.baseUrl}/notifications`, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(await failureMessage(response, "could not list notifications"));
    }

    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as NotificationRecord[]) : [];
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Notification provider request failed: ${message}`);
    }
  }
}

async function failureMessage(response: Response, action: string): Promise<string> {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (body && typeof body.error === "string") {
      detail = body.error;
    }
  } catch {
    detail = null;
  }
  return detail === null
    ? `Notification provider ${action} with status ${response.status}`
    : `Notification provider ${action}: ${detail}`;
}
