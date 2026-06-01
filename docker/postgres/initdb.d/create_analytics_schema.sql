-- Bootstraps the `analytics` schema before TypeORM tries to create its
-- `migrations` table inside it. Runs once per fresh data volume (Postgres
-- initdb only fires on first boot; volumes that already exist won't
-- re-run this — see entrypoint fallback for that case).
CREATE SCHEMA IF NOT EXISTS analytics;
