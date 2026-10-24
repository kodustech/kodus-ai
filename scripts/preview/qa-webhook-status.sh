#!/usr/bin/env bash
# Read only QA diagnostics for gym#134. Prints status fields, never payloads or credentials.
set -euo pipefail

docker ps --filter name=kodus_worker --format 'worker={{.Status}}'
docker exec -i db_postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT status,
       metadata->>'event' AS event,
       payload->>'action' AS action,
       COALESCE(payload->'issue'->>'number',
                payload->'pull_request'->>'number') AS pr,
       COALESCE("errorClassification"::text, '')
FROM kodus_workflow.workflow_jobs
WHERE "workflowType" = 'WEBHOOK_PROCESSING'
  AND "createdAt" > now() - interval '2 hours'
  AND payload->'repository'->>'id' = '930934303'
ORDER BY "createdAt" DESC LIMIT 12;
SQL
