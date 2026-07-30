#!/usr/bin/env bash
# Diagnose the self-hosted droplet end-to-end without forcing the local
# terminal to escape megabytes of SQL/Mongo quoting through SSH.
#
# Runs ONE remote script that captures all four layers at once:
#
#   - cloudflared tunnel state (URL + service liveness)
#   - webhooks-prod container traffic (POST hits in the last N minutes)
#   - RabbitMQ topology (queues + consumers + messages, with connection
#     fallbacks so an empty list is unambiguous)
#   - Postgres workflow_jobs table (last 10 rows)
#   - MongoDB pullRequests collection (last 5 rows)
#
# Usage:
#   pnpm run selfhosted:diag                  # full sweep
#   pnpm run selfhosted:diag pg               # only Postgres
#   pnpm run selfhosted:diag mongo            # only Mongo
#   pnpm run selfhosted:diag rmq              # only RabbitMQ
#   pnpm run selfhosted:diag tunnel           # only tunnel + recent webhook POSTs
#   pnpm run selfhosted:diag pipeline         # tail recent azure_pipeline logs
#   pnpm run selfhosted:diag unlock-outbox    # release orphan PROCESSING locks
#   pnpm run selfhosted:diag reset-failed     # PROCESSING/PENDING with no recent activity → READY/PENDING

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

NAME_RAW="${KODUS_DIAG_NAME:-default}"
WHAT="${1:-all}"

NAME=$(normalize_name "$NAME_RAW")
state_exists "$NAME" || { err "No instance named '$NAME'"; exit 1; }

# All remote work runs as a single heredoc so local quoting never reaches
# psql/mongosh/rabbitmqctl. The remote bash script handles its own escapes.
ssh_to "$NAME" bash <<REMOTE
set -u

log_step() { printf '\n=== %s ===\n' "\$1"; }

if [ "$WHAT" = "all" ] || [ "$WHAT" = "tunnel" ]; then
  log_step "Tunnel state"
  systemctl is-active kodus-tunnel.service 2>&1 || true
  echo "URL: \$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /var/log/cloudflared.log | tail -1)"
  echo ""
  echo "POSTs to /azure-repos in last 10 min (webhooks-prod):"
  docker logs --since 10m kodus-webhooks-prod 2>&1 | grep -c "POST /azure-repos" || echo "0"
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "rmq" ]; then
  log_step "RabbitMQ — connections"
  docker exec rabbitmq-prod rabbitmqctl list_connections name peer_host state user 2>&1 | head -30 || true
  log_step "RabbitMQ — vhosts"
  docker exec rabbitmq-prod rabbitmqctl list_vhosts name 2>&1 | head -10 || true
  log_step "RabbitMQ — queues (default vhost / + alternative)"
  docker exec rabbitmq-prod rabbitmqctl --formatter=table list_queues name messages messages_ready consumers 2>&1 | head -30 || true
  echo ""
  echo "-- via mgmt API (works when ctl times out):"
  docker exec rabbitmq-prod sh -c 'wget -q -O - --user=\$RABBITMQ_DEFAULT_USER --password=\$RABBITMQ_DEFAULT_PASS http://localhost:15672/api/queues 2>/dev/null | head -c 800' 2>&1 || echo "(mgmt API unavailable)"
  log_step "RabbitMQ — channels (consumers attached?)"
  docker exec rabbitmq-prod rabbitmqctl list_channels name number prefetch_count consumer_count 2>&1 | head -20 || true
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "pg" ]; then
  log_step "Postgres — list all tables"
  cd /opt/kodus-installer
  set -a
  . ./.env
  set +a
  docker exec -e PGPASSWORD="\$API_PG_DB_PASSWORD" db_kodus_postgres \
    psql -U "\$API_PG_DB_USERNAME" -d "\$API_PG_DB_DATABASE" \
    -c '\dt' \
    2>&1 || true
  log_step "Postgres — typeorm_migrations (which ran?)"
  docker exec -e PGPASSWORD="\$API_PG_DB_PASSWORD" db_kodus_postgres \
    psql -U "\$API_PG_DB_USERNAME" -d "\$API_PG_DB_DATABASE" \
    -c 'SELECT id, name, timestamp FROM migrations ORDER BY id DESC LIMIT 10;' \
    2>&1 || true
  log_step "Postgres — last 10 workflow_jobs (if table exists)"
  docker exec -e PGPASSWORD="\$API_PG_DB_PASSWORD" db_kodus_postgres \
    psql -U "\$API_PG_DB_USERNAME" -d "\$API_PG_DB_DATABASE" \
    -c 'SELECT id, status, workflow_type, handler_type, created_at FROM workflow_jobs ORDER BY created_at DESC LIMIT 10;' \
    2>&1 || true
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "mongo" ]; then
  log_step "Mongo — last 5 pullRequests"
  cd /opt/kodus-installer
  set -a
  . ./.env
  set +a
  docker exec db_kodus_mongodb \
    mongosh --quiet \
    -u "\$API_MG_DB_USERNAME" \
    -p "\$API_MG_DB_PASSWORD" \
    --authenticationDatabase admin \
    "\$API_MG_DB_DATABASE" \
    --eval 'db.pullRequests.find({}, {number:1, repository:1, createdAt:1}).sort({createdAt:-1}).limit(5).toArray()' \
    2>&1 || true
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "pipeline" ]; then
  log_step "Worker — last 20 azure_pipeline traces"
  docker logs --since 30m kodus-worker-prod 2>&1 | grep "azure_pipeline" | tail -20 || true
  log_step "Webhooks — last 20 azure_pipeline traces"
  docker logs --since 30m kodus-webhooks-prod 2>&1 | grep "azure_pipeline" | tail -20 || true
fi

# Release orphan outbox locks left behind by a dead worker. The OutboxRelay
# poll only `claimBatch`-es rows with status='READY'; rows held in
# 'PROCESSING' by a worker that died mid-publish stay invisible to the new
# worker forever (no built-in lock-expiry visitor today). Run after a deploy
# or container restart if `pnpm run selfhosted:diag pg` shows lingering
# PROCESSING outbox rows from a previous instance.
if [ "$WHAT" = "unlock-outbox" ]; then
  log_step "Releasing orphan PROCESSING outbox locks back to READY"
  cd /opt/kodus-installer
  set -a
  . ./.env
  set +a
  docker exec -e PGPASSWORD="\$API_PG_DB_PASSWORD" db_kodus_postgres \
    psql -U "\$API_PG_DB_USERNAME" -d "\$API_PG_DB_DATABASE" \
    -c "UPDATE kodus_workflow.outbox_messages
        SET status = 'READY',
            \"lockedBy\" = NULL,
            \"lockedAt\" = NULL
        WHERE status = 'PROCESSING'
        RETURNING uuid, attempts, \"createdAt\";" \
    2>&1 || true
  log_step "Status counts after unlock"
  docker exec -e PGPASSWORD="\$API_PG_DB_PASSWORD" db_kodus_postgres \
    psql -U "\$API_PG_DB_USERNAME" -d "\$API_PG_DB_DATABASE" \
    -c "SELECT status, COUNT(*) FROM kodus_workflow.outbox_messages GROUP BY status;" \
    2>&1 || true
fi

# Also reset workflow_jobs that are stuck PENDING with no startedAt but
# whose corresponding outbox message is SENT — these are the result of
# a worker dying after publish-ack but before the WEBHOOK_RAW processor
# claimed the message. Without this, every new job will be delayed by
# whichever queue-fairness mechanism is in play.
if [ "$WHAT" = "reset-failed" ]; then
  log_step "Resetting PENDING workflow_jobs with no progress in last 30min"
  cd /opt/kodus-installer
  set -a
  . ./.env
  set +a
  docker exec -e PGPASSWORD="\$API_PG_DB_PASSWORD" db_kodus_postgres \
    psql -U "\$API_PG_DB_USERNAME" -d "\$API_PG_DB_DATABASE" \
    -c "UPDATE kodus_workflow.workflow_jobs
        SET \"updatedAt\" = NOW()
        WHERE status = 'PENDING'
          AND \"startedAt\" IS NULL
          AND \"createdAt\" < NOW() - INTERVAL '30 minutes'
        RETURNING uuid, \"workflowType\", \"createdAt\";" \
    2>&1 || true
fi
REMOTE
