-- What the Runtime hub's read-only role on the product database
-- (kodus_runtime_secrets_reader, RUNTIME_PRODUCT_SECRETS_READ_URL) may read: the
-- org secrets' id, name and hosts in runtime_secrets, so a claim gets them by
-- reference (docs/runtime/sandbox.md "Secrets: OpenBao"). No other column of
-- that table (who and when), no other table, no write. The value is never in
-- this database: it lives in OpenBao. Idempotent; run against the product
-- database after the migration CreateRuntimeSecrets2026111200000010. Applied
-- by dev-runtime-users.sh and, in the integration suite, by
-- org-secret-refs.integration.spec.ts.
DO $$
BEGIN
  IF to_regclass('public.runtime_secrets') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO kodus_runtime_secrets_reader';
    EXECUTE 'REVOKE ALL ON public.runtime_secrets FROM kodus_runtime_secrets_reader';
    EXECUTE 'GRANT SELECT (organization_id, secret_id, name, hosts) ON public.runtime_secrets TO kodus_runtime_secrets_reader';
  END IF;
END $$;
