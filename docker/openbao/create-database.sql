-- OpenBao's own database and role in the Postgres Kodus runs, so the product
-- backup covers the vault. Idempotent; run as an admin with psql -v pw=<password>.
-- OpenBao creates its tables (openbao_kv_store) at its first start.
SELECT 'CREATE ROLE openbao LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openbao')\gexec

ALTER ROLE openbao WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';

SELECT 'CREATE DATABASE kodus_openbao OWNER openbao'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kodus_openbao')\gexec

REVOKE ALL ON DATABASE kodus_openbao FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE kodus_openbao TO openbao;
