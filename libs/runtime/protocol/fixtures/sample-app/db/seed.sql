-- Idempotent: runs from the Postgres initdb (plain compose) and from the
-- recipe's data.seed (psql), possibly both.
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    item TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0)
);
INSERT INTO orders (id, item, quantity) VALUES (1, 'keyboard', 2), (2, 'monitor', 1)
ON CONFLICT (id) DO NOTHING;
SELECT setval('orders_id_seq', (SELECT MAX(id) FROM orders));
