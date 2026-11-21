#!/usr/bin/env bash
# Least-privilege Runtime identities on the product dev stack (ADR-046),
# idempotent. Runs the admin side inside the running containers (db_postgres,
# rabbitmq) with their own admin env; nothing secret is printed. The Runtime
# has no Mongo user: everything it stores is in its own Postgres.
#   Postgres: role kodus_runtime, owner of database kodus_runtime only; CONNECT
#             revoked from PUBLIC on every other database.
#   Postgres: role kodus_runtime_reader, SELECT on the Runtime tables the
#             product API reads (runtime-reader-grants.sql: runtime_cells,
#             runtime_egress_*, runtime_run_events, the Run stream,
#             runtime_claims, what a Run's claims held for its cost, the
#             runtime_machine_usage view, the org's machine minutes today, and
#             runtime_runs, runtime_environment_setups and runtime_lessons, the
#             Run projection, the setups and the lessons), plus only
#             scope/org/cleared_at on runtime_stops for fail-closed external
#             admission: the API's RUNTIME_DATABASE_READ_URL, never the owner's.
#   Postgres: role kodus_runtime_secrets_reader on the product database,
#             SELECT on the org secrets' id, name and hosts only
#             (runtime-secrets-reader-grants.sql): the hub's
#             RUNTIME_PRODUCT_SECRETS_READ_URL. Re-run after the product
#             migration CreateRuntimeSecrets2026111200000010.
#   RabbitMQ: user kodus_runtime on the product vhost, least privilege:
#             configure only its own queue (and amq.gen-* for the e2e sink),
#             never a product exchange (declare workflow.exchange passively);
#             publish on workflow.exchange only with the RUNTIME_PUBLISH
#             routing key (topic permission), dead-letter to
#             workflow.exchange.dlx; consume workflow.jobs.runtime_run.queue
#             and workflow.jobs.runtime_control.queue.
# Writes <certs-dir>/runtime-users.env (0600): RUNTIME_DATABASE_URL,
# RUNTIME_DATABASE_READ_URL, RUNTIME_PRODUCT_SECRETS_READ_URL, RUNTIME_RABBITMQ_URL
# for docker-compose.dev.yml.
# Usage: scripts/runtime/dev-runtime-users.sh [certs-dir]
set -euo pipefail
OUT="${1:-.runtime-certs}"
mkdir -p "$OUT" && chmod 700 "$OUT"
umask 077
F="$OUT/runtime-users.env"
VHOST="${RUNTIME_RABBITMQ_VHOST:-kodus-ai}"
GRANTS="$(dirname "$0")/runtime-reader-grants.sql"
SECRETS_GRANTS="$(dirname "$0")/runtime-secrets-reader-grants.sql"
pw() { openssl rand -hex 24; }
if [[ -f "$F" ]]; then
  # shellcheck disable=SC1090
  . "$F"
fi
PG_PW="${RUNTIME_PG_PASSWORD:-$(pw)}"
MQ_PW="${RUNTIME_MQ_PASSWORD:-$(pw)}"
RD_PW="${RUNTIME_READER_PG_PASSWORD:-$(pw)}"
SR_PW="${RUNTIME_SECRETS_READER_PG_PASSWORD:-$(pw)}"
# The product database, as the db_postgres container names it.
PRODUCT_DB="$(docker exec db_postgres sh -c 'printf %s "$POSTGRES_DB"')"

# --- Postgres ---------------------------------------------------------------
docker exec -i -e RT_PW="$PG_PW" db_postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d postgres -v pw="$RT_PW"' <<'SQL'
SELECT format('CREATE ROLE kodus_runtime LOGIN PASSWORD %L', :'pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodus_runtime') \gexec
SELECT format('ALTER ROLE kodus_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw') \gexec
SELECT 'CREATE DATABASE kodus_runtime OWNER kodus_runtime' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'kodus_runtime') \gexec
ALTER DATABASE kodus_runtime OWNER TO kodus_runtime;
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', datname) FROM pg_database WHERE NOT datistemplate \gexec
GRANT CONNECT ON DATABASE kodus_runtime TO kodus_runtime;
SQL
# Objects an earlier boot created as the admin move to the Runtime role.
docker exec -i db_postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d kodus_runtime' <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO kodus_runtime', r.nspname);
  END LOOP;
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE (c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  -- a serial's sequence follows its table; only free-standing ones move here
                  OR (c.relkind = 'S' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))))
             AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO kodus_runtime',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname);
  END LOOP;
  FOR r IN SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER ROUTINE %I.%I(%s) OWNER TO kodus_runtime', r.nspname, r.proname, r.args);
  END LOOP;
END $$;
SQL

# Read-only role of the product API on the Runtime database. Re-run after the
# Runtime's first boot: the tables it reads are created by the Runtime.
docker exec -i -e RT_PW="$RD_PW" db_postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d kodus_runtime -v pw="$RT_PW"' <<'SQL'
SELECT format('CREATE ROLE kodus_runtime_reader LOGIN PASSWORD %L', :'pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodus_runtime_reader') \gexec
SELECT format('ALTER ROLE kodus_runtime_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw') \gexec
GRANT CONNECT ON DATABASE kodus_runtime TO kodus_runtime_reader;
SQL
docker exec -i db_postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d kodus_runtime' <"$GRANTS"

# Read-only role of the Runtime hub on the product database: the org secrets'
# references (never a value; values live in OpenBao). Re-run after the product
# migration that creates runtime_secrets.
docker exec -i -e RT_PW="$SR_PW" db_postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d postgres -v pw="$RT_PW" -v db="$POSTGRES_DB"' <<'SQL'
SELECT format('CREATE ROLE kodus_runtime_secrets_reader LOGIN PASSWORD %L', :'pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodus_runtime_secrets_reader') \gexec
SELECT format('ALTER ROLE kodus_runtime_secrets_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO kodus_runtime_secrets_reader', :'db') \gexec
SQL
docker exec -i db_postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$SECRETS_GRANTS"

# --- RabbitMQ --------------------------------------------------------------
docker exec rabbitmq sh -c "rabbitmqctl -q list_users | grep -qw kodus_runtime || rabbitmqctl -q add_user kodus_runtime '$MQ_PW' >/dev/null"
docker exec rabbitmq sh -c "rabbitmqctl -q change_password kodus_runtime '$MQ_PW' >/dev/null"
Q='workflow\.jobs\.runtime_(run|control)\.queue'
# The retry exchange, and the dead-letter exchange the queues name: RabbitMQ
# checks write access to a queue's x-dead-letter-exchange at every declare.
D='workflow\.exchange\.runtime_retry|workflow\.exchange\.dlx'
# configure, write, read. No configure on workflow.exchange: that would let the
# Runtime delete the product's exchange. Passive declares need no permission.
docker exec rabbitmq rabbitmqctl -q set_permissions -p "$VHOST" kodus_runtime \
  "^(${Q}|amq\.gen-.*)\$" \
  "^(workflow\.exchange|${D}|${Q}|amq\.gen-.*)\$" \
  "^(workflow\.exchange|${Q}|amq\.gen-.*)\$" >/dev/null
# Topic permissions on the product exchange: write (publish) only the
# RUNTIME_PUBLISH routing key, never a product job (CODE_REVIEW, the trigger);
# read (bind) only the Runtime's own bindings.
docker exec rabbitmq rabbitmqctl -q set_topic_permissions -p "$VHOST" kodus_runtime workflow.exchange \
  '^workflow\.jobs\.created\.RUNTIME_PUBLISH$' \
  '^workflow\.jobs\.(\*|created)\.RUNTIME_(RUN|CONTROL)$' >/dev/null
# The product initializer owns the private retry exchange and its Run and
# control bindings. Publish-only access prevents the Runtime adding another
# binding or bridging it back into the product exchange. No shared delayed/DLX write.

cat >"$F" <<ENV
RUNTIME_PG_PASSWORD=$PG_PW
RUNTIME_MQ_PASSWORD=$MQ_PW
RUNTIME_READER_PG_PASSWORD=$RD_PW
RUNTIME_SECRETS_READER_PG_PASSWORD=$SR_PW
RUNTIME_DATABASE_URL=postgres://kodus_runtime:$PG_PW@db_postgres:5432/kodus_runtime
RUNTIME_DATABASE_READ_URL=postgres://kodus_runtime_reader:$RD_PW@db_postgres:5432/kodus_runtime
RUNTIME_PRODUCT_SECRETS_READ_URL=postgres://kodus_runtime_secrets_reader:$SR_PW@db_postgres:5432/$PRODUCT_DB
RUNTIME_RABBITMQ_URL=amqp://kodus_runtime:$MQ_PW@rabbitmq-local:5672/$VHOST?heartbeat=60
ENV
chmod 600 "$F"
echo "runtime users ready (postgres, rabbitmq); credentials in $F, not printed"
