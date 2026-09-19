-- 001_init.sql - authoritative schema and seed for the migrated ShopFlow stack.
-- Owner: shopflow-infra. Applied by the one-shot `migrate` Compose service before `api` starts.
-- Idempotent: this script must be safe to run repeatedly (CREATE ... IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- It must NOT reset stock or overwrite existing rows on re-run.

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL
);

-- Preserved from the monolith, including the dormant cancellation columns.
-- `CANCELLED` remains a valid stored value for data compatibility but no code path writes it.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT
);

-- Internal delivery guarantee for the preserved ORDER_CONFIRMATION side effect.
-- Not part of the external HTTP contract; never exposed through the API.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT notification_outbox_status_check CHECK (status IN ('PENDING', 'SENT'))
);

-- Exactly one delivery intent per order and notification type.
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_order_type_idx
  ON notification_outbox (order_id, type);

-- Preserved idempotent seed (values are part of the observable behaviour).
INSERT INTO products (id, name, price_cents, stock) VALUES
  ('prod-a', 'Product A', 1999, 20),
  ('prod-b', 'Product B', 999, 10)
ON CONFLICT (id) DO NOTHING;
