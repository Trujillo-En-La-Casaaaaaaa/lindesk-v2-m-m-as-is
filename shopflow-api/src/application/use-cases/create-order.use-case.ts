import { invalidOrder, insufficientStock, productNotFound } from "../../domain/errors.js";
import {
  ORDER_CONFIRMATION,
  orderConfirmationPayload,
} from "../../domain/notification.js";
import { CONFIRMED_ORDER_STATUS } from "../../domain/order-status.js";
import { isValidOrderInput } from "../../domain/order.js";
import type { Order } from "../../domain/order.js";
import { computeTotalCents } from "../../domain/pricing.js";
import type {
  CreateOrderCommand,
  CreateOrderUseCase,
} from "../ports/in/create-order.js";
import type { Clock } from "../ports/out/clock.js";
import type { IdGenerator } from "../ports/out/id-generator.js";
import type { UnitOfWork } from "../ports/out/unit-of-work.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";

/**
 * Create an order, preserving the legacy transaction and notification semantics:
 *
 * 1. input validation before any database access (`400 Invalid order`);
 * 2. one transaction: product read (`404 Product not found`) -> conditional stock decrement
 *    (`400 Insufficient stock`) -> order insert (`CONFIRMED`, `totalCents = priceCents * quantity`)
 *    -> exactly one `ORDER_CONFIRMATION` outbox intent (`PENDING`) -> single commit;
 *    any failure rolls everything back;
 * 3. after the commit, deliver the notification in-request (retries with backoff). Success marks the
 *    intent `SENT` and the order is returned (`201`). If every attempt fails, the error propagates
 *    (`500`) while the order stays committed and the intent stays `PENDING` for the outbox relay -
 *    the legacy post-commit failure mode, with nothing lost.
 */
export class CreateOrder implements CreateOrderUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly dispatcher: NotificationDispatcher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateOrderCommand): Promise<Order> {
    if (!isValidOrderInput(command)) {
      throw invalidOrder();
    }

    const orderId = this.ids.nextId();
    const intentId = this.ids.nextId();
    const createdAt = this.clock.nowIso();

    const { order, intent } = await this.unitOfWork.run(async (tx) => {
      const product = await tx.products.getById(command.productId);
      if (!product) {
        throw productNotFound();
      }

      const decremented = await tx.products.decrementStock(command.productId, command.quantity);
      if (!decremented) {
        throw insufficientStock();
      }

      const created = await tx.orders.create({
        id: orderId,
        customerEmail: command.customerEmail,
        status: CONFIRMED_ORDER_STATUS,
        productId: command.productId,
        quantity: command.quantity,
        totalCents: computeTotalCents(product.priceCents, command.quantity),
        createdAt,
      });

      const staged = await tx.outbox.enqueue({
        id: intentId,
        orderId: created.id,
        type: ORDER_CONFIRMATION,
        payload: orderConfirmationPayload(created.id, created.customerEmail),
        createdAt,
      });

      return { order: created, intent: staged };
    });

    await this.dispatcher.dispatch(intent);

    return order;
  }
}
