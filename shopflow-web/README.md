# shopflow-web

The browser UI of the migrated ShopFlow system: a React + TypeScript single-page application built
with Vite and served by nginx. It replaces the monolith's server-rendered HTML pages with the same
four routes, the same field-level content and the same messages, and it consumes only the frozen
`/api/*` JSON contract through a same-origin reverse proxy.

```
browser ──▶ http://127.0.0.1:3000  (this container)
              ├─ /            static SPA assets from /usr/share/nginx/html
              └─ /api/*  ──▶  http://api:3001   (shopflow-api, the only backend)
```

## Purpose and scope

- Renders the catalog, product detail, order creation, order detail/status and the administrative
  SHIPPED action.
- Calls exactly five API operations: `GET /api/products`, `GET /api/products/:id`, `POST /api/orders`,
  `GET /api/orders/:id`, `POST /api/orders/:id/ship`.
- Holds no business rule, no SQL, no connection string and no database driver: the API is the only
  writer of products and orders, and `tests/no-database-access.test.ts` fails the build if a database
  dependency or connection string ever appears here.
- Adds nothing beyond those four routes: no cancellation control, no product administration, no
  notification screen and no authentication.

## Routes

| Route | Content |
| ----- | ------- |
| `/` | Heading "ShopFlow Catalog", table of ID / Name / Price / Stock with a `View` link per product and a "Create order" link |
| `/products/:id` | Product name as heading, `ID: <id>`, `Price: <priceCents> cents`, `Stock: <stock>` and a "Back" link; `Not found` when the API answers `404` |
| `/orders/new` | Heading "Create order" and a form with a product select labelled `<name> (stock <stock>)`, a quantity number input defaulting to `1` with `min=1`, a required email input and the "Place order" button |
| `/orders/:id` | Heading "Order <id>", the order pretty-printed with 2-space indentation, a "Mark SHIPPED" button only while `status === "CONFIRMED"` and a "Home" link; `Not found` when the API answers `404` |

On submit the order form calls `POST /api/orders`; a success navigates to `/orders/<id>`, a rejection
displays the API's `error` message verbatim (`Invalid order`, `Product not found`,
`Insufficient stock`) without navigating. The order detail view is the only place that issues
`POST /api/orders/:id/ship`, and only for a `CONFIRMED` order; the response is the authoritative view
of the new status, so the button disappears as soon as the order is `SHIPPED`.

Every non-2xx response is turned into an error that carries the response `error` message; when a
response has no usable message (or the request never reached the API), the legacy generic text
`Unexpected error` is displayed instead.

## Configuration

| Key | Default | Meaning |
| --- | ------- | ------- |
| `VITE_API_BASE` | `/api` | Base path of the JSON API. A relative, same-origin path; nginx proxies `/api/*` to the `api` service. |

`.env.example` documents that single key. There is no host, credential, token or database setting in
this repository.

## Build, test and run

```bash
npm ci                 # install the locked dependencies
npm test               # Vitest + React Testing Library + MSW: route, api-client and guard suites
npm run build          # tsc --noEmit && vite build  -> static bundle in dist/
npm run dev            # local Vite dev server (proxy to a stack is not configured; use the stack)
```

Inside the composed stack (driven from `shopflow-infra`, the two application repositories checked out
as siblings):

```bash
docker compose up -d --build                 # builds this repository as the `web` service
curl -I http://127.0.0.1:3000/               # 200, the SPA document
curl http://127.0.0.1:3000/api/health        # {"ok":true}, proving /api is proxied unchanged
```

`nginx.conf` serves `/usr/share/nginx/html` with an index fallback so client-side routes work on
reload, and forwards `location /api/` to `http://api:3001` without rewriting the path. The published
port is `3000:80`, so the user-facing origin stays `http://127.0.0.1:3000` and no CORS configuration
is part of the contract. The image is `node:22-alpine` for the build stage and `nginx:alpine` for the
runtime, which contains no Node process and no database client.

### Observed results

Run on Windows 11 with Node 24.14.0, npm 11.9.0 and Docker 28.2.2:

| Command | Observed |
| ------- | -------- |
| `npm ci && npm test` | 6 test files, 32 tests passed (route, api-client and guard suites) |
| `npm run build` | `tsc --noEmit` clean; `dist/index.html` + `dist/assets/index-*.js` + `dist/assets/index-*.css` |
| `docker build -t shopflow-web .` | image built; inside it only `nginx` plus the static assets (no `node`, no database client) |
| `docker compose up -d --build` (shopflow-infra) | `db`, `notification-provider`, `api` and `web` healthy |
| `curl -I http://127.0.0.1:3000/` | `200`, `text/html` |
| `curl http://127.0.0.1:3000/api/health` | `{"ok":true}` (the `/api` prefix reaches the API unchanged) |

A scripted browser walkthrough of the four routes against that stack (headless Edge driven over the
DevTools protocol, starting from a freshly seeded stack) passed 23/23 checks: the catalog rows match
`GET /api/products`, `/products/prod-a` shows `ID: prod-a` / `Price: 1999 cents` / `Stock: 20`,
`/products/does-not-exist` and `/orders/does-not-exist` render `Not found`, the order form offers
`Product A (stock 20)` with quantity `1`/`min=1`, an over-stock submission shows
`Insufficient stock` in place, an empty quantity shows `Invalid order` in place, a valid submission
navigates to `/orders/<id>` with `"status": "CONFIRMED"` and the "Mark SHIPPED" button, clicking it
yields `"status": "SHIPPED"` with the button gone, the catalog then shows the decremented stock
(`18`), and a direct reload of `/orders/<id>` still renders the shipped order. The black-box
acceptance phase of `shopflow-infra` (`behavior-preservation` + `concurrency`) also passed 12/12
against this container.

## Tests

| Suite | Covers |
| ----- | ------ |
| `tests/catalog.test.tsx` | Catalog heading, table columns, rows, `View` and "Create order" links |
| `tests/product.test.tsx` | Product heading, `ID`, `Price: <priceCents> cents`, `Stock`, "Back", and `Not found` on `404` |
| `tests/new-order.test.tsx` | Option labels `<name> (stock <n>)`, quantity default `1` with `min=1`, required email, successful creation, the `CONFIRMED` → `SHIPPED` transition, the stock change visible in the catalog, and the `Invalid order` / `Product not found` / `Insufficient stock` messages |
| `tests/order.test.tsx` | Pretty-printed order, "Mark SHIPPED" only for `CONFIRMED`, hidden after shipping, `Cannot ship order`, `Not found` |
| `tests/api-client.test.ts` | The five calls, base path, and status/message extraction for `400`, `404`, `500` |
| `tests/no-database-access.test.ts` | No database driver, connection string or SQL anywhere; only `VITE_API_BASE`; static packaging |

`tests/mocks/handlers.ts` implements the frozen `/api/*` contract with MSW (stateful, so order
creation decrements stock and the SHIPPED transition is guarded) and `tests/setupTests.ts` wires it
into Vitest; unknown requests fail the test, which keeps the SPA honest about the endpoints it uses.
