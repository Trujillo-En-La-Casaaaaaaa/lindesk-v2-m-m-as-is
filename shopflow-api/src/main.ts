import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { Express } from "express";
import type { Pool } from "pg";

import { createApp } from "./adapters/inbound/http/server.js";
import { HttpNotificationAdapter } from "./adapters/outbound/notification/http-notification.adapter.js";
import { OutboxRelay } from "./adapters/outbound/outbox/outbox.relay.js";
import { PgNotificationOutbox } from "./adapters/outbound/postgres/notification-outbox.pg.js";
import { PgOrderRepository } from "./adapters/outbound/postgres/order-repository.pg.js";
import { createPool } from "./adapters/outbound/postgres/pool.js";
import { PgProductRepository } from "./adapters/outbound/postgres/product-repository.pg.js";
import { PgUnitOfWork } from "./adapters/outbound/postgres/unit-of-work.pg.js";
import { SystemClock } from "./application/ports/out/clock.js";
import { UuidIdGenerator } from "./application/ports/out/id-generator.js";
import { CreateOrder } from "./application/use-cases/create-order.use-case.js";
import { DeliverPendingNotifications } from "./application/use-cases/deliver-pending-notifications.use-case.js";
import { GetOrder } from "./application/use-cases/get-order.use-case.js";
import { GetProduct } from "./application/use-cases/get-product.use-case.js";
import { ListNotifications } from "./application/use-cases/list-notifications.use-case.js";
import { ListProducts } from "./application/use-cases/list-products.use-case.js";
import { NotificationDispatcher } from "./application/use-cases/notification-dispatcher.js";
import { ShipOrder } from "./application/use-cases/ship-order.use-case.js";
import { loadConfig } from "./config/env.js";
import type { AppConfig } from "./config/env.js";

/**
 * Composition root: the only place concrete adapters are chosen and injected into the use cases.
 * Everything downstream depends on ports, never on this module.
 */
export interface Composition {
  config: AppConfig;
  app: Express;
  pool: Pool;
  relay: OutboxRelay;
  /** Stop the relay and release the connection pool. */
  close(): Promise<void>;
}

export function createComposition(config: AppConfig = loadConfig()): Composition {
  const pool = createPool(config.databaseUrl);
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();

  // Outbound adapters.
  const productRepository = new PgProductRepository(pool);
  const orderRepository = new PgOrderRepository(pool);
  const notificationOutbox = new PgNotificationOutbox(pool);
  const unitOfWork = new PgUnitOfWork(pool);
  const notificationPort = new HttpNotificationAdapter(config.notificationProviderUrl);

  // Application services and use cases.
  const dispatcher = new NotificationDispatcher(
    notificationOutbox,
    notificationPort,
    clock,
    config.notificationRetryAttempts,
  );
  const deliverPendingNotifications = new DeliverPendingNotifications(notificationOutbox, dispatcher);
  const useCases = {
    listProducts: new ListProducts(productRepository),
    getProduct: new GetProduct(productRepository),
    createOrder: new CreateOrder(unitOfWork, dispatcher, clock, ids),
    getOrder: new GetOrder(orderRepository),
    shipOrder: new ShipOrder(orderRepository),
    listNotifications: new ListNotifications(notificationPort),
  };

  // Inbound adapter and background relay.
  const app = createApp({ useCases });
  const relay = new OutboxRelay(deliverPendingNotifications, config.outboxRelayIntervalMs);

  return {
    config,
    app,
    pool,
    relay,
    async close(): Promise<void> {
      await relay.stop();
      await pool.end();
    },
  };
}

async function main(): Promise<void> {
  const composition = createComposition();
  const { port } = composition.config;

  // Listening first keeps `/api/health` available for the container healthcheck without touching the
  // database or the notification provider; the relay only starts once the HTTP surface is up.
  const server: Server = composition.app.listen(port, () => {
    console.log(`shopflow-api listening on ${port}`);
  });
  composition.relay.start();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`shopflow-api received ${signal}, shutting down`);
    await composition.relay.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await composition.close();
    process.exit(0);
  };

  process.on("SIGTERM", (signal) => void shutdown(signal));
  process.on("SIGINT", (signal) => void shutdown(signal));
}

const entryPoint = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entryPoint !== null && entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`shopflow-api failed to start: ${message}`);
    process.exitCode = 1;
  });
}
