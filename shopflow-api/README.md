# shopflow-api

Hexagonal TypeScript/Node.js service that serves the frozen ShopFlow `/api/*` JSON contract and owns
every read and write of `products`, `orders` and the internal `notification_outbox` table.

It reproduces the application behaviour of the legacy Express monolith exactly (validation order,
transactional order creation, conditional stock decrement, guarded shipping, order-confirmation
notification) while moving the notification side effect behind an outbound port and an internal
transactional outbox, so delivery is reliable across retries and restarts.

The browser UI is **not** part of this repository (`shopflow-web` serves it and calls this API), and
neither is the database schema (`shopflow-infra` owns the DDL, the seed and the notification-provider
emulator).

## Hexagonal architecture and the dependency rule

```
inbound HTTP adapter (Express)
        │  calls inbound ports only
        ▼
application ports/in (use-case interfaces) ──▶ application/use-cases (one file per use case)
                                                   │  depends on
                                                   ▼
                                            domain (rules, errors) + ports/out
                                                                  │ implemented by
                                                                  ▼
                                      outbound adapters: postgres · http notification · outbox relay
                                                                  │ wired by
                                              main.ts (composition root) reading config/env.ts
```

Dependencies point inwards only:

- `src/domain/**` and `src/application/**` contain no `express`, no `pg` and no adapter import - the
  architecture test fails the build if that changes;
- all SQL lives in `src/adapters/outbound/postgres/**`; there is no DDL, migration or ORM anywhere in
  this repository (`tests/architecture/dependency-rule.test.ts` enforces both);
- domain errors carry a semantic kind (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `UNEXPECTED`) plus the
  preserved message; the inbound adapter maps kinds to `400`/`404`/`400`/`500` and never rewords a
  message.

```
src/
  domain/            product, order, order-status, notification, pricing, errors
  application/
    ports/in/        ListProducts, GetProduct, CreateOrder, GetOrder, ShipOrder,
                     ListNotifications, DeliverPendingNotifications
    ports/out/       ProductRepository, OrderRepository, UnitOfWork, NotificationPort,
                     NotificationOutbox, Clock, IdGenerator
    use-cases/       one file per use case + the shared notification dispatcher
  adapters/
    inbound/http/    server, router, controllers, error-mapping, request-validation
    outbound/postgres/          pool, row-mappers, product/order repositories, unit of work, outbox
    outbound/notification/      http-notification.adapter.ts
    outbound/outbox/            outbox.relay.ts
  config/env.ts      environment parsing and defaults
  main.ts            composition root (the only place adapters are chosen)
```

## Preserved behaviour

- `GET /api/health`, `GET /api/products`, `GET /api/products/:id`, `POST /api/orders`,
  `GET /api/orders/:id`, `POST /api/orders/:id/ship`, `GET /api/notifications` - seven routes, nothing
  else; any other path (including `POST /api/orders/:id/cancel`) is `404`.
- `POST /api/orders` validates input before any database access (`400 Invalid order`), then reads the
  product (`404 Product not found`), then performs the conditional decrement
  (`UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2`, `400 Insufficient stock`),
  then inserts the order (`CONFIRMED`, `totalCents = priceCents * quantity`) and the delivery intent,
  and commits once. Any failure rolls the whole transaction back.
- Stock can never go negative: two concurrent orders for the last unit yield exactly one `201` and one
  `400 Insufficient stock`.
- Shipping is the guarded `CONFIRMED -> SHIPPED` update; it never touches stock and never notifies.
- A `quantity` that coerces to `NaN` keeps its legacy path: it passes validation and fails in
  PostgreSQL as a non-2xx (`500`) with no order row and no stock change - it is never a success and
  never a new `400` branch.
- Cancellation does not exist: no use case, port, route or status is produced. The `CANCELLED` status
  value, `cancelled_at` and `cancellation_reason` remain supported as dormant data for compatibility.

## Notification delivery: port + outbox + relay

1. `CreateOrder` commits the order together with exactly one `notification_outbox` row
   (`PENDING`, `ORDER_CONFIRMATION`, payload `{customerEmail, orderId}`, unique per
   `(order_id, type)`).
2. After the commit it delivers the notification in-request through the HTTP notification port, up to
   `NOTIFICATION_RETRY_ATTEMPTS` attempts with 100 ms/300 ms backoff, and only then answers `201`.
   The outbox row id is the idempotency key, so a retry can never create a second record.
3. If every attempt fails, the caller receives `500 {"error":"<message>"}` while the order stays
   committed and the intent stays `PENDING` with an incremented attempt count - the legacy
   post-commit failure semantics, with nothing lost.
4. The outbox relay runs on startup and every `OUTBOX_RELAY_INTERVAL_MS`, retries `PENDING` intents
   with the same idempotency key, marks them `SENT` and logs failures. Intents are never deleted, so a
   crash between the provider append and the outbox update still ends with exactly one
   `ORDER_CONFIRMATION` per order.
5. `GET /api/notifications` is read through the port (the provider owns the notification storage), so
   the response keeps the legacy record shape and insertion order.

## Configuration

Every value comes from the environment (`src/config/env.ts`); missing required values fail fast with a
clear message and nothing is hardcoded. `.env.example` documents the same keys.

| Variable | Required | Default | Purpose |
| -------- | -------- | ------- | ------- |
| `DATABASE_URL` | yes | - | PostgreSQL connection string (schema owned by `shopflow-infra`) |
| `NOTIFICATION_PROVIDER_URL` | yes | - | Base URL of the notification provider (`http://notification-provider:4010` in Compose) |
| `PORT` | no | `3001` | HTTP port of this service |
| `NOTIFICATION_RETRY_ATTEMPTS` | no | `3` | In-request delivery attempts before the intent stays `PENDING` |
| `OUTBOX_RELAY_INTERVAL_MS` | no | `10000` | Background relay interval |
| `TEST_DATABASE_URL` | test only | - | Database used by the integration/characterization suites |
| `API_BASE_URL` (or `BASE_URL`) / `PROVIDER_URL` | test only | - | Composed stack endpoints for the contract suite; Vitest/Vite overwrite `BASE_URL` with their own `/` default, so the resolver ignores anything that is not an absolute http(s) URL |

## Commands

```bash
npm ci && npm run build        # install and compile with strict TypeScript
npm start                      # node dist/main.js, logs "shopflow-api listening on 3001"
npm test                       # unit, use-case, architecture, characterization and adapter tests
npm run test:unit              # domain, application and inbound-adapter tests (no infrastructure)
npm run test:architecture      # dependency rule, SQL/DDL confinement, no cancellation surface
npm run test:integration       # real PostgreSQL: atomicity, no-oversell, outbox recovery
npm run test:characterization  # legacy edge cases (non-numeric quantity, identifiers, boundaries)
npm run test:contract          # frozen HTTP contract + notification-provider contract
```

Test suites that need infrastructure skip with an explicit message and never fake a pass:

```bash
# real PostgreSQL integration + characterization (schema applied by shopflow-infra)
TEST_DATABASE_URL=postgres://shopflow:shopflow@127.0.0.1:5433/shopflow npm run test:integration
TEST_DATABASE_URL=postgres://shopflow:shopflow@127.0.0.1:5433/shopflow npm run test:characterization

# frozen contract and provider agreement against the composed stack
BASE_URL=http://127.0.0.1:3001 PROVIDER_URL=http://127.0.0.1:4010 npm run test:contract
# equivalent in-process run (composed service on an ephemeral port, real adapters)
TEST_DATABASE_URL=postgres://shopflow:shopflow@127.0.0.1:5433/shopflow PROVIDER_URL=http://127.0.0.1:4010 npm run test:contract
```

Docker:

```bash
docker build -t shopflow-api .
docker run --rm -e DATABASE_URL=postgres://shopflow:shopflow@host.docker.internal:5433/shopflow \
  -e NOTIFICATION_PROVIDER_URL=http://host.docker.internal:4010 -p 3001:3001 shopflow-api
curl http://127.0.0.1:3001/api/health   # {"ok":true}
```

The image is a multi-stage `node:22-alpine` build (`tsc` in the build stage, `node dist/main.js` as the
non-root `node` user, `EXPOSE 3001`) and contains no migration step: the schema is applied by the
`migrate` service of `shopflow-infra` before this container starts.

## Tests and requirement traceability

| Requirement | Test |
| ----------- | ---- |
| Domain rules, pricing, status guards, no cancellation transition | `tests/unit/domain/*.test.ts` |
| Use cases in isolation (success, `Invalid order`, `Product not found`, `Insufficient stock`, `Cannot ship order`, rollback) | `tests/unit/use-cases/*.test.ts` |
| Hexagonal separation, SQL/DDL confinement, no cancellation surface | `tests/architecture/dependency-rule.test.ts` |
| HTTP adapter routing, parsing, error mapping, 404 surface | `tests/unit/adapters/*.test.ts` |
| Inventory decrement, transaction atomicity, row mapping | `tests/integration/postgres/inventory.test.ts` |
| Concurrency / no oversell | `tests/integration/postgres/concurrent-orders.test.ts` |
| Notification durability and recovery | `tests/integration/outbox-relay.test.ts` |
| Frozen HTTP contract (status codes, bodies, key sets, ordering) | `tests/contract/http-api.test.ts` |
| Order-confirmation notification and provider idempotency | `tests/contract/notification-provider.test.ts` |
| Legacy edge cases (non-numeric quantity, identifiers, boundaries) | `tests/characterization/*.test.ts` |

The integration and characterization suites do not open transactions of their own for assertions about
production behaviour: they drive the real use cases and read the resulting rows back. The notification
provider is the only collaborator replaced (`tests/support/fakes.ts`), because it is an external
service.

## Ownership boundaries

- `shopflow-infra` owns the schema (`products`, `orders` with the dormant cancellation columns,
  `notification_outbox`), the idempotent migration/seed, the PostgreSQL service, the notification
  provider emulator and the black-box acceptance suite. This repository creates and alters no table
  and needs no DDL to run its tests; without the infrastructure schema the database-backed suites fail
  with a pointer to that migration.
- `shopflow-web` owns the browser UI and reaches this API through `/api/*` on the shared origin.
- This repository is the only runtime writer of `products`/`orders`, exposes no additional endpoint and
  implements no cancellation feature.
