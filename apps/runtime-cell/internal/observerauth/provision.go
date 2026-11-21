package observerauth

import (
	"errors"
	"fmt"
	"time"
)

// ProvisionSQL is a fixed transaction for a supported plain PostgreSQL schema.
// Names/verifier are validated before substitution; catalog object names use
// PostgreSQL format(%I). No repository command or plaintext password enters it.
func ProvisionSQL(c Credential, verifier string, expiresAt time.Time) ([]byte, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if !validVerifier(verifier) {
		return nil, errors.New("observerauth: invalid verifier")
	}
	if expiresAt.IsZero() || expiresAt.Year() < 2000 || expiresAt.Year() > 9999 {
		return nil, errors.New("observerauth: invalid account expiry")
	}
	// This deliberately refuses richer schemas rather than promising that a
	// SELECT against arbitrary views/routines/RLS has no side effects.
	s := fmt.Sprintf(`BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
DO $kody$
DECLARE r oid; o record;
BEGIN
 IF current_database() <> '%[1]s' THEN RAISE EXCEPTION 'KODY_OBSERVER_TARGET_UNSUPPORTED'; END IF;
 SELECT oid INTO r FROM pg_roles WHERE rolname = '%[2]s';
 IF r IS NULL THEN
  CREATE ROLE "%[2]s" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '%[3]s';
  SELECT oid INTO r FROM pg_roles WHERE rolname = '%[2]s';
 ELSE
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid=r AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r)
    OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=r)
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=r)
  THEN RAISE EXCEPTION 'KODY_OBSERVER_SCHEMA_UNSAFE'; END IF;
  ALTER ROLE "%[2]s" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '%[3]s';
 END IF;
 IF has_database_privilege(r,current_database(),'CREATE') OR has_schema_privilege(r,'public','CREATE')
    OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND has_function_privilege(r,p.oid,'EXECUTE'))
    OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%%' AND n.nspname NOT LIKE 'pg_temp_%%'
        AND (c.relkind IN ('v','m','f') OR c.relrowsecurity))
    OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%%' AND n.nspname NOT LIKE 'pg_temp_%%'
        AND c.relkind IN ('r','p') AND has_table_privilege(r,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    OR EXISTS (
      SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE a.grantee=0 AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','CREATE','TRIGGER','REFERENCES'))
 THEN RAISE EXCEPTION 'KODY_OBSERVER_SCHEMA_UNSAFE'; END IF;
 GRANT CONNECT ON DATABASE "%[1]s" TO "%[2]s";
 GRANT USAGE ON SCHEMA public TO "%[2]s";
 FOR o IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') LOOP
  EXECUTE format('GRANT SELECT ON TABLE public.%%I TO %%I',o.relname,'%[2]s');
 END LOOP;
END
$kody$;
ALTER ROLE "%[2]s" VALID UNTIL '%[4]s';
ALTER ROLE "%[2]s" RESET ALL;
ALTER ROLE "%[2]s" SET default_transaction_read_only = on;
ALTER ROLE "%[2]s" SET statement_timeout = '10s';
ALTER ROLE "%[2]s" SET lock_timeout = '2s';
ALTER ROLE "%[2]s" SET search_path = pg_catalog, public;
COMMIT;
`, c.Database, c.Username, verifier, expiresAt.UTC().Format(time.RFC3339))
	return []byte(s), nil
}
