# shopflow-infra

Infrastructure and delivery repository for the migrated ShopFlow system. It owns the Docker Compose
topology, the PostgreSQL 16 environment and its schema/seed migration, the deterministic
notification-provider emulator, and the black-box acceptance suite that proves the migration preserved
behaviour.

It contains **no application business logic**: the API rules belong to `shopflow-api` and the UI to
`shopflow-web`.

```
browser ──▶ web  (nginx, published origin http://127.0.0.1:3000)
              └─ /api/* ──▶ api:3001 ──▶ db:5432  (PostgreSQL 16, schema owned here)
                               └────────▶ notification-provider:4010 ──▶ notify_data (append-only JSONL)
```

| Service | Image / build | Host port | Purpose |
| ------- | ------------- | --------- | ------- |
| `db` | `postgres:16-alpine` | `5433 → 5432` | PostgreSQL 16; data on the `shopflow_pg` volume; `pg_isready` healthcheck |
| `migrate` | `postgres:16-alpine` | - | one-shot `psql -v ON_ERROR_STOP=1 -f /migrations/001_init.sql`; idempotent schema + seed; `restart: "no"` |
| `notification-provider` | `build: ./notification-provider` | `4010 → 4010` | notification-provider emulator; JSONL store on the `notify_data` volume; `/health` healthcheck |
| `api` | `build: ${API_CONTEXT:-../shopflow-api}` | `3001 → 3001` | the application API; starts after `db` is healthy and `migrate` completed; `/api/health` healthcheck |
| `web` | `build: ${WEB_CONTEXT:-../shopflow-web}` | `3000 → 80` | the only browser-facing container; serves the SPA and proxies `/api/*` to `http://api:3001` |
| `acceptance` | `build: ./acceptance` | - | black-box acceptance suite (`profiles: ["test"]`), started by the acceptance drivers |

Named volumes: `shopflow_pg` (database), `notify_data` (notification JSONL store). One default bridge
network, so the service DNS names `db`, `migrate`, `notification-provider`, `api`, `web` resolve. Those
service names, ports and volumes are a cross-repository contract: `shopflow-web`'s nginx config proxies
to `http://api:3001`.

## Layout

```
shopflow-infra/
  docker-compose.yml          topology, healthchecks, startup ordering, volumes
  .env.example                every non-secret environment key with local defaults
  migrations/001_init.sql     authoritative, idempotent DDL + seed (products, orders, notification_outbox)
  notification-provider/      deterministic, fully offline provider emulator + its own tests
  acceptance/                 black-box behavioural/durability proof + drivers
```

## Prerequisite: sibling checkouts

The build contexts default to sibling directories, so the three repositories must be checked out side
by side:

```
<workspace>/
  shopflow-infra/
  shopflow-api/
  shopflow-web/
```

For any other layout, set the build contexts (`.` in this repository):

| Key | Default | Meaning |
| --- | ------- | ------- |
| `API_CONTEXT` | `../shopflow-api` | build context of the `api` service |
| `WEB_CONTEXT` | `../shopflow-web` | build context of the `web` service |

```bash
API_CONTEXT=/path/to/shopflow-api WEB_CONTEXT=/path/to/shopflow-web docker compose up -d --build
# or copy .env.example to .env and edit the two paths
```

`shopflow-api` and `shopflow-web` are built from their own repositories; nothing of their source is
vendored here.

## Start, inspect, stop

```bash
docker compose up -d --build          # the single startup command: builds, migrates, starts, health-gates
docker compose ps                     # every service healthy
curl http://127.0.0.1:3000/api/health # {"ok":true}
curl -I http://127.0.0.1:3000/        # 200 (SPA document, served by `web`)
```

```bash
docker compose stop api web           # stop individual services
docker compose restart api            # restart one service (used by the durability phase)
docker compose down                   # stop and remove containers, keep the volumes (data survives)
docker compose down -v --remove-orphans  # full reset: removes shopflow_pg and notify_data (fresh seed state)
```

Startup ordering is enforced with healthchecks: `migrate` waits for `db` to be healthy, `api` waits
for `db` healthy + `migrate` completed successfully + `notification-provider` healthy, and `web` waits
for `api` healthy.

## Database environment and migrations

- PostgreSQL 16 (`postgres:16-alpine`) with `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` from
  the environment (local defaults `shopflow` / `shopflow` / `shopflow`), published on host port `5433`,
  data on the `shopflow_pg` volume.
- `migrations/001_init.sql` is the **only** DDL for this system. It creates `products`,
  `orders` (including the dormant `cancelled_at` / `cancellation_reason` columns) and the internal
  `notification_outbox` table (`status IN ('PENDING','SENT')`, unique index on `(order_id, type)`),
  then inserts the preserved seed (`prod-a` = Product A / 1999 / 20, `prod-b` = Product B / 999 / 10).
- The script is idempotent and non-destructive (`CREATE TABLE IF NOT EXISTS`,
  `CREATE UNIQUE INDEX IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`): running it again leaves
  every row - including current stock - unchanged. `shopflow-api` contains no DDL and never migrates.
- `notification_outbox` is internal delivery bookkeeping for the exactly-one-`ORDER_CONFIRMATION`
  guarantee; it is never exposed through the API.

```bash
# apply the migration again (a no-op) and prove the data did not change
docker compose run --rm migrate
docker compose exec db psql -U shopflow -d shopflow -c \
  "select count(*) as products from products; select id, stock from products order by id;"
```

## notification-provider emulator

A deterministic, fully offline stand-in for the provider the monolith simulated with an in-process
JSONL writer. It is a TypeScript/Node.js service on `node:http` only (no runtime dependency), listens
on `4010`, and is the only writer of the JSONL store.

| Endpoint | Behaviour |
| -------- | --------- |
| `GET /health` | `200 {"ok":true}` |
| `POST /notifications` | `{idempotencyKey, type, orderId, payload}` → `201` with the created record the first time, `200` with the existing record for a repeated key, `400 {"error":"Invalid notification"}` for an invalid payload, `500 {"error":"Storage failure"}` on a write failure |
| `GET /notifications` | `200` with all records in append order (oldest first) |

The record shape is the monolith's, unchanged: `{id, type, orderId, createdAt, payload}` with
`payload.orderId` ensured - the idempotency key is kept in a separate sidecar file
(`NOTIFICATION_IDEMPOTENCY_PATH`) so the primary log stays byte-compatible. Records are appended to
`NOTIFICATION_LOG_PATH` and flushed (`fsync`) **before** the response is written, appends are
serialized in one writer queue, and nothing is ever fetched from the network.

```bash
cd notification-provider
npm ci && npm test          # builds with tsc and runs the node:test suite (12 tests)
```

The suite covers the contract end to end: health, the exact record shape, duplicate-key idempotency,
two keys for one order, invalid payloads appending nothing, a real **process restart** over the same
JSONL files, concurrent same-key and multi-key submits (no interleaved lines), no outbound network
call (socket guard), and a source/dependency scan proving only `node:` built-ins are used.

## Acceptance suite

`acceptance/` drives the composed stack black-box (`node:test` + `fetch`, no browser automation) and
is the integration gate of the migration.

```bash
./run-acceptance.sh              # POSIX shell driver: reset -> up -> phase 1 -> restart durability -> provider outage durability
./run-acceptance.sh --down       # same, then `docker compose down` (without -v) at the end
```

```powershell
.\run-acceptance.ps1
.\run-acceptance.ps1 -Down
```

The drivers always start from `docker compose down -v --remove-orphans`, wait for `db`,
`notification-provider`, `api` and `web` to report healthy, run the phase-1 suite
(`behavior-preservation` requirements 1-9 + the `concurrency` invariant), then `docker compose restart
api` and the durability phase, then a provider-outage phase, print a pass/fail summary and exit
non-zero on any failure. The stack is left running with its volumes intact so a failure can be
inspected. See `acceptance/README.md` for the requirement-to-test mapping and the per-phase commands.

## Environment

`.env.example` documents every non-secret key with safe local defaults: `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `API_PORT`, `WEB_PORT`, `API_CONTEXT`,
`WEB_CONTEXT`, `NOTIFICATION_PROVIDER_URL`, `NOTIFICATION_LOG_PATH`,
`NOTIFICATION_IDEMPOTENCY_PATH`. Compose reads a `.env` file from this directory automatically; the
committed defaults are local development values only, and no real secret, token or credential is
stored here. The values in `.env.example` are the in-network ones (`db:5432`,
`notification-provider:4010`); for host-side access use the published ports `5433`, `4010`, `3001`,
`3000`.

## Verification

| # | Command | Expected |
| - | ------- | -------- |
| 1 | `docker compose config` | valid configuration with the resolved build contexts |
| 2 | `docker compose up -d --build` + `docker compose ps` | every service `healthy` (except the one-shot `migrate`, which exits `0`) |
| 3 | `curl http://127.0.0.1:3000/api/health` / `curl -I http://127.0.0.1:3000/` | `{"ok":true}` / `200` |
| 4 | `docker compose run --rm migrate` twice | the second run is a no-op: same product count and stock |
| 5 | `cd notification-provider && npm ci && npm test` | 12/12 provider tests pass |
| 6 | `./run-acceptance.sh` (or `.\run-acceptance.ps1`) | every phase passes from a reset state; per-phase names in the summary |
| 7 | `docker compose down -v --remove-orphans` | clean shutdown and cleanup |

## Ownership boundaries

- `shopflow-infra` (this repository) owns: the Compose topology, the PostgreSQL environment, the schema
  and seed migration, the notification-provider emulator, the acceptance suite, `.env.example` and
  this documentation.
- `shopflow-api` owns the `/api/*` business rules and is the only runtime writer of `products`,
  `orders` and `notification_outbox`; it is built from its own repository.
- `shopflow-web` owns the browser UI and reaches the API only through `/api/*` on the shared origin.
- Customer order cancellation, product administration, order editing, authentication, brokers and
  metrics stacks are out of scope and must not appear here.
