# shopflow-infra acceptance suite

Black-box verification of the migrated ShopFlow system: it drives the **composed** stack over HTTP
(`node:test` + the global `fetch`, no browser automation, no database access, no dependencies) through
the single published origin and never inspects internals. Everything it asserts is part of the frozen
external contract.

The suite is owned by `shopflow-infra` and is the integration gate for the whole migration: it is the
only place that exercises `shopflow-web`, `shopflow-api`, the PostgreSQL schema and the
notification-provider emulator together.

## Requirements mapped to tests

| Requirement (handoff) | Test file / test name |
| --------------------- | --------------------- |
| Acceptance criterion 1 - the stack answers on the published origin | `behavior-preservation.test.mjs` › `acceptance criterion 1: the composed stack answers on the published origin` (`GET /api/health` → `{"ok":true}`) |
| 1 - seeded catalog exactly (ordered by id) + SPA document at `/` | › `requirement 1: GET /api/products returns the seeded catalog ordered by id and GET / serves the SPA` |
| 2 - `GET /api/products/:id` returns the product with its current stock | › `requirement 2: GET /api/products/:id returns the product with its current stock` |
| 3 - order creation: `201 CONFIRMED`, `totalCents`, ISO `createdAt`, dormant cancellation fields `null` | › `requirement 3: POST /api/orders creates a CONFIRMED order with the preserved payload shape` |
| 4 - rejection contract (`Invalid order`, `Product not found`, `Insufficient stock`, no row/stock/notification change) | › `requirement 4: rejected orders keep their exact contract and change nothing` |
| 4 (legacy path) - non-numeric quantity stays a `500`, never a new `400` branch | › `requirement 4: a non-numeric quantity keeps its legacy 500 path and creates no order` |
| 5 - stock decremented by the ordered quantity | › `requirement 5: a successful order decremented the stock by the ordered quantity` |
| 6 - `GET /api/orders/:id` and `404 {"error":"Not found"}` | › `requirement 6: GET /api/orders/:id returns the created order and 404 Not found for an unknown id` |
| 7 - guarded one-way `CONFIRMED → SHIPPED`, no stock change, `400 Cannot ship order` otherwise | › `requirement 7: POST /api/orders/:id/ship is a guarded one-way transition that never touches stock` |
| 8 - exactly one `ORDER_CONFIRMATION` per order, none for rejected orders | › `requirement 8: exactly one ORDER_CONFIRMATION exists for the order and none for rejected orders` |
| 9 - no cancellation surface | › `requirement 9: no cancellation surface exists` (`POST /api/orders/:id/cancel` → `404`) |
| Concurrency invariant - two parallel orders for the last unit | `concurrency.test.mjs` › `concurrency invariant: two parallel orders for the last unit of prod-b produce exactly one 201` |
| Restart durability - order created before `docker compose restart api` is still readable, exactly one notification per order, no duplicate after the relay retries | `restart-durability.test.mjs` › `api restart durability (phase: prepare…)` and `(phase: verify…)` |
| Notification durability - a failed delivery stays pending and the relay delivers it exactly once after the provider returns | `restart-durability.test.mjs` › `provider outage durability (phase: pending…)` and `(phase: recovered…)` |

## Phases and the exact commands

`run-acceptance.sh` (POSIX shell) and `run-acceptance.ps1` (Windows PowerShell) are equivalent, fully
self-contained drivers:

1. `docker compose down -v --remove-orphans` - fresh volumes, reproducible seed state.
2. `docker compose up -d --build`.
3. Poll `docker inspect` until `db`, `notification-provider`, `api` and `web` are `healthy` (timeout
   `API_HEALTH_TIMEOUT`, default 300 s).
4. Phase 1: `behavior-preservation` + `concurrency` (also the image's default command).
5. Durability prepare, then `docker compose restart api`, wait for `api` to be healthy again, then
   durability verify.
6. Fault injection: `docker compose stop notification-provider`, run the `pending` phase,
   `docker compose start notification-provider`, wait for health, run the `recovered` phase.
7. Print a pass/fail summary and exit non-zero on any failure. The stack is left running with its
   volumes so a failure can be inspected; `--down` (`-Down`) performs `docker compose down` (never
   `-v`) at the end.

```bash
# from shopflow-infra/
./run-acceptance.sh                # full run, stack left up for inspection
./run-acceptance.sh --down         # full run, then `docker compose down`
ACCEPTANCE_BASE_URL=http://host.docker.internal:3000 ./run-acceptance.sh
```

```powershell
# from shopflow-infra\ on Windows
.\run-acceptance.ps1
.\run-acceptance.ps1 -Down
```

Single phase, by hand (the stack must already be in the matching state):

```bash
# phase 1 against the in-network origin (service DNS name `web`)
docker compose run --rm --no-deps acceptance node --test --test-concurrency=1 \
  tests/behavior-preservation.test.mjs tests/concurrency.test.mjs

# the same suite from the host, through the published origin
cd acceptance && BASE_URL=http://127.0.0.1:3000 npm test

# restart durability (needs: prepare -> `docker compose restart api` -> verify)
docker compose run --rm --no-deps -e DURABILITY_PHASE=prepare acceptance \
  node --test --test-concurrency=1 tests/restart-durability.test.mjs
docker compose restart api
docker compose run --rm --no-deps -e DURABILITY_PHASE=verify acceptance \
  node --test --test-concurrency=1 tests/restart-durability.test.mjs

# provider outage (needs: stop notification-provider -> pending -> start -> recovered)
docker compose stop notification-provider
docker compose run --rm --no-deps -e DURABILITY_PHASE=pending acceptance \
  node --test --test-concurrency=1 tests/restart-durability.test.mjs
docker compose start notification-provider
docker compose run --rm --no-deps -e DURABILITY_PHASE=recovered acceptance \
  node --test --test-concurrency=1 tests/restart-durability.test.mjs
```

## Environment

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `BASE_URL` | `http://web` | Origin under test. `http://web` is the nginx container inside the Compose network; use `http://host.docker.internal:3000` (or `http://127.0.0.1:3000` when running Node on the host) for the published origin. |
| `DURABILITY_PHASE` | `verify` | Which durability phase to run: `prepare`, `verify`, `pending`, `recovered`. |
| `DURABILITY_ORDER_TAG` | `default` | Correlates the marker orders across the durability phases (the driver passes a fresh tag per run). |
| `OUTBOX_RELAY_INTERVAL_MS` | `10000` | The api's relay interval, so the durability phases wait long enough for another relay pass. Keep it equal to the api's configuration. |
| `API_HEALTH_TIMEOUT` | `300` | Health-poll timeout in seconds (driver only). |

## Design notes

- **The container cannot restart containers.** A black-box test container has no Docker socket, so the
  api restart and the provider outage are performed by the driver between the phases; the durability
  file therefore runs in four modes. The pre-restart order is correlated by a marker
  `customerEmail` built from `DURABILITY_ORDER_TAG`, because the id of the order created during the
  outage is never returned to the client (`500`), exactly as in the monolith.
- **Fresh state is required.** Requirement 1 asserts the seeded catalog (`prod-a` 20, `prod-b` 10) and
  the concurrency test needs `prod-b` stock, so the driver always starts from `down -v`.
- **Files run sequentially** (`--test-concurrency=1`): the suites share one stack and one seed state.
- **No test hides a failure.** Every assertion is a hard assertion; the suites never skip, never mock
  and never fall back to an in-memory substitute.
