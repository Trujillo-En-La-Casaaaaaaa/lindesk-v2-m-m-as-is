import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { OrderRepository, ProductRepository } from "../repositories/index.js";
import { NotificationAdapter } from "./notificationAdapter.js";
import type { Order, Product } from "../models/types.js";

export class OrderService {
  private products = new ProductRepository();
  private orders = new OrderRepository();
  private notifications = new NotificationAdapter();

  listProducts(): Promise<Product[]> {
    return this.products.list();
  }

  getProduct(id: string): Promise<Product | null> {
    return this.products.getById(id);
  }

  getOrder(id: string): Promise<Order | null> {
    return this.orders.getById(id);
  }

  listNotifications() {
    return this.notifications.list();
  }

  async createOrder(input: {
    productId: string;
    quantity: number;
    customerEmail: string;
  }): Promise<Order> {
    if (!input.customerEmail || input.quantity < 1) {
      throw Object.assign(new Error("Invalid order"), { status: 400 });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const product = await this.products.getById(input.productId, client);
      if (!product) {
        throw Object.assign(new Error("Product not found"), { status: 404 });
      }
      const ok = await this.products.decrementStock(
        input.productId,
        input.quantity,
        client
      );
      if (!ok) {
        throw Object.assign(new Error("Insufficient stock"), { status: 400 });
      }
      const order = await this.orders.create(
        {
          id: randomUUID(),
          customerEmail: input.customerEmail,
          status: "CONFIRMED",
          productId: input.productId,
          quantity: input.quantity,
          totalCents: product.priceCents * input.quantity,
          createdAt: new Date().toISOString(),
        },
        client
      );
      await client.query("COMMIT");
      await this.notifications.record("ORDER_CONFIRMATION", order.id, {
        customerEmail: order.customerEmail,
      });
      return order;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async shipOrder(id: string): Promise<Order> {
    const order = await this.orders.markShipped(id);
    if (!order) {
      throw Object.assign(new Error("Cannot ship order"), { status: 400 });
    }
    return order;
  }
}
