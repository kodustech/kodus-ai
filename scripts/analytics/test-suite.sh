#!/usr/bin/env bash
#
# End-to-end integration test suite for the analytics ingestion pipeline.
# Targets the local docker-compose stack (the `analytics-selfhosted`
# worktree with its `as_*` containers — see docker-compose.override.yml).
#
# Each test case (Tx_y) runs in sequence:
#   1. Resets the relevant slice of state (Mongo + Postgres analytics)
#   2. Seeds synthetic data
#   3. Triggers an ingestion via POST /cockpit/admin/trigger-ingestion
#   4. Asserts on Postgres state via psql
#   5. Prints PASS/FAIL
#
# Prereqs:
#   - `pnpm run docker:start` has been run; all `as_*` containers up.
#   - `as_kodus_api` was started AFTER `API_ANALYTICS_ALLOW_TRIGGER=true`
#     was added to docker-compose.override.yml (you may need to restart
#     it once after pulling this branch).
#
# Usage:
#   bash scripts/analytics/test-suite.sh           # run all
#   bash scripts/analytics/test-suite.sh T2_3      # run a single test
#
# Exit: 0 if all PASS, 1 if any FAIL.

set -uo pipefail

API_URL="${API_URL:-http://localhost:3011}"
MONGO_CONTAINER="${MONGO_CONTAINER:-as_mongodb}"
PG_CONTAINER="${PG_CONTAINER:-as_db_postgres}"
MONGO_USER="${MONGO_USER:-kodusdev}"
MONGO_PASS="${MONGO_PASS:-123456}"
MONGO_DB="${MONGO_DB:-kodus_db}"
PG_USER="${PG_USER:-kodusdev}"
PG_DB="${PG_DB:-kodus_db}"
WORKER_CONTAINER="${WORKER_CONTAINER:-as_kodus_analytics_worker}"

# Tag prefix for all seeded test orgs; --reset uses this to scope deletes.
ORG_PREFIX="${ORG_PREFIX:-analytics-test}"

# ---------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
green() { color '32' "$*"; }
red()   { color '31' "$*"; }
blue()  { color '34' "$*"; }
yellow() { color '33' "$*"; }

log()    { echo "$(blue "[$(date +%H:%M:%S)]") $*"; }
pass()   { echo "  $(green "PASS") $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()   { echo "  $(red "FAIL") $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_TESTS+=("$1"); }
section() { echo; echo "$(yellow "── $* ──")"; }

mongo_eval() {
    docker exec "$MONGO_CONTAINER" mongosh \
        -u "$MONGO_USER" -p "$MONGO_PASS" \
        --authenticationDatabase admin "$MONGO_DB" \
        --quiet --eval "$1"
}

psql_q() {
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "$1"
}

# Run seed inside the worker container (which has node_modules).
seed() {
    docker exec "$WORKER_CONTAINER" pnpm run analytics:seed-test "$@" >/dev/null 2>&1
}

backfill_http() {
    # Drives the orchestrator via the API admin endpoint (avoids the
    # Nest+ts-node bootstrap issue with mongoose-paginate that the
    # standalone CLI hits). Same gate as `trigger`.
    local status
    status=$(curl -sS --retry 3 --retry-delay 1 \
        --retry-connrefused --max-time 300 \
        -o /tmp/backfill-body -w '%{http_code}' \
        -X POST "$API_URL/cockpit/admin/backfill$1" \
        2>/dev/null || echo "000")
    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        local body
        body=$(cat /tmp/backfill-body 2>/dev/null || echo '')
        >&2 echo "  $(red "backfill failed [$status]") $body"
        return 1
    fi
    return 0
}

trigger() {
    # Fires the run. Fails fast with a clear message when the endpoint
    # is gated (403) or the API container is out of sync with the env.
    # `--retry 3` absorbs transient blips (hot-reload mid-run, brief
    # disconnect) — without it, dev-mode webpack rebuilds caused
    # spurious failures in the suite.
    local status
    status=$(curl -sS --retry 3 --retry-delay 1 \
        --retry-connrefused --max-time 60 \
        -o /tmp/trigger-body -w '%{http_code}' \
        -X POST "$API_URL/cockpit/admin/trigger-ingestion$1" \
        2>/dev/null || echo "000")
    local body
    body=$(cat /tmp/trigger-body 2>/dev/null || echo '')
    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        # Emit on stderr so the caller's `>/dev/null` (which only
        # suppresses the normal response body) still shows the failure.
        >&2 echo "  $(red "trigger failed [$status]") $body"
        if [ "$status" = "403" ]; then
            >&2 echo "  hint: $(yellow 'API container needs `docker compose -f docker-compose.dev.yml -f docker-compose.override.yml --profile local-db up -d --force-recreate kodus-api` to pick up API_ANALYTICS_ALLOW_TRIGGER')"
        fi
        return 1
    fi
    return 0
}

reset_warehouse() {
    psql_q "
        TRUNCATE analytics.pull_requests_opt CASCADE;
        TRUNCATE analytics.suggestions_mv;
        TRUNCATE analytics.commits_view;
        TRUNCATE analytics.ingestion_errors;
        DELETE FROM analytics.watermarks;
        DELETE FROM analytics.backfill_progress;
        DELETE FROM analytics.ingestion_runs;
    " >/dev/null
}

reset_mongo_test_orgs() {
    # Delete ALL docs whose organizationId starts with the test prefix
    # (covers any number of seeded orgs, including -001..-004 when a
    # previous case used --orgs 4, plus the -edge variant).
    mongo_eval "db.pullRequests.deleteMany({organizationId: { \$regex: '^${ORG_PREFIX}-' }})" >/dev/null
    # Clean the bad-pr injected by T2.3 (organizationId is null, so the
    # regex above misses it). Identified by a fixed title marker.
    mongo_eval "db.pullRequests.deleteMany({title: 'analytics-test-suite-bad-pr'})" >/dev/null
}

assert_eq() {
    # assert_eq <label> <actual> <expected>
    if [ "$2" = "$3" ]; then
        pass "$1 (got $2)"
    else
        fail "$1 (expected $3, got $2)"
    fi
}

assert_ge() {
    # assert_ge <label> <actual> <min>
    if [ "$2" -ge "$3" ]; then
        pass "$1 (got $2 ≥ $3)"
    else
        fail "$1 (expected ≥ $3, got $2)"
    fi
}

# ---------------------------------------------------------------------
# T2.1 — Happy path: 50 PRs in 1 org, all ingest cleanly.
# ---------------------------------------------------------------------
T2_1() {
    section "T2.1 — Happy path (50 PRs, 1 org)"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 1 --prs 50

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    local pr_count
    pr_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt;")
    assert_eq "pull_requests_opt count" "$pr_count" "50"

    local last_status
    last_status=$(psql_q "SELECT status FROM analytics.ingestion_runs ORDER BY id DESC LIMIT 1;")
    assert_eq "last run status" "$last_status" "ok"

    local quarantined
    quarantined=$(psql_q "SELECT errors_quarantined FROM analytics.ingestion_runs ORDER BY id DESC LIMIT 1;")
    assert_eq "errors quarantined" "$quarantined" "0"

    local wm_id
    wm_id=$(psql_q "SELECT last_source_id FROM analytics.watermarks WHERE table_name = 'pull_requests';")
    if [ -n "$wm_id" ] && [ "$wm_id" != "" ]; then
        pass "tuple watermark _id populated ($wm_id)"
    else
        fail "tuple watermark _id should be populated"
    fi
}

# ---------------------------------------------------------------------
# T2.2 — Tuple watermark survives same-timestamp ties.
# ---------------------------------------------------------------------
T2_2() {
    section "T2.2 — Tuple watermark (same updatedAt)"
    reset_warehouse
    reset_mongo_test_orgs
    # Seed only the edge org which has the tuple-twins (PR 9001/9002).
    seed --orgs 0 --prs 0 --with-edge-cases

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    local edge_count
    edge_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt WHERE \"organizationId\" = '${ORG_PREFIX}-edge';")
    # 4 edge cases total, but malformed (#9003) might quarantine.
    assert_ge "edge org PRs ingested" "$edge_count" "3"

    # Both twins must be present — same updatedAt, different _id.
    local twin_count
    twin_count=$(psql_q "
        SELECT COUNT(*) FROM analytics.pull_requests_opt
        WHERE \"organizationId\" = '${ORG_PREFIX}-edge'
          AND source_updated_at IN (
              SELECT source_updated_at
              FROM analytics.pull_requests_opt
              WHERE \"organizationId\" = '${ORG_PREFIX}-edge'
              GROUP BY source_updated_at
              HAVING COUNT(*) >= 2
          );
    ")
    assert_ge "tuple-twin PRs both ingested (same updatedAt)" "$twin_count" "2"
}

# ---------------------------------------------------------------------
# T2.3 — Quarantine: a PR with NULL organizationId must land in
# `ingestion_errors` without breaking the rest of the batch.
# Disabled by default because the seed CLI doesn't currently inject
# this exact shape; T2.3 is a placeholder until we extend the seed.
# ---------------------------------------------------------------------
T2_3() {
    section "T2.3 — Quarantine (manual NULL organizationId)"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 1 --prs 10

    # Inject one bad doc directly via mongosh. Title is a fixed marker
    # so reset_mongo_test_orgs can clean it up between runs (its
    # organizationId is null, so the prefix-based reset misses it).
    mongo_eval "db.pullRequests.insertOne({
        _id: ObjectId(),
        title: 'analytics-test-suite-bad-pr',
        number: 99999,
        status: 'open',
        organizationId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        files: [],
        commits: []
    })" >/dev/null

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    local good_count
    good_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt WHERE \"organizationId\" LIKE '${ORG_PREFIX}-%';")
    assert_eq "good PRs still ingested" "$good_count" "10"

    local err_count
    err_count=$(psql_q "SELECT COUNT(*) FROM analytics.ingestion_errors;")
    assert_ge "ingestion_errors row(s) recorded" "$err_count" "1"
}

# ---------------------------------------------------------------------
# T2.4 — Idempotency: a second trigger over the same data is a no-op.
# ---------------------------------------------------------------------
T2_4() {
    section "T2.4 — Idempotency (re-trigger does nothing new)"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 1 --prs 25

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }
    local count_after_first
    count_after_first=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt;")

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }
    local count_after_second
    count_after_second=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt;")

    assert_eq "row count unchanged after re-trigger" \
        "$count_after_second" "$count_after_first"

    # The second run scanned 0 (watermark advanced past everything).
    local last_scanned
    last_scanned=$(psql_q "SELECT scanned FROM analytics.ingestion_runs ORDER BY id DESC LIMIT 1;")
    assert_eq "second run scanned 0" "$last_scanned" "0"
}

# ---------------------------------------------------------------------
# T2.5 — Org-scoped trigger only ingests one tenant.
# ---------------------------------------------------------------------
T2_5() {
    section "T2.5 — Org scope (single-tenant trigger)"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 3 --prs 10

    trigger "?organizationId=${ORG_PREFIX}-001" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    local org1_count
    org1_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt WHERE \"organizationId\" = '${ORG_PREFIX}-001';")
    assert_eq "scoped org ingested" "$org1_count" "10"

    local other_count
    other_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt WHERE \"organizationId\" != '${ORG_PREFIX}-001';")
    assert_eq "other orgs untouched" "$other_count" "0"
}

# ---------------------------------------------------------------------
# T2.6 — Health endpoints reflect the latest run.
# ---------------------------------------------------------------------
T2_6() {
    section "T2.6 — /cockpit/health/runs reflects latest run"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 1 --prs 5

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    # Graceful parse: print empty string when `last` is null so
    # assert_eq reports a clean "expected ok, got '' " instead of a
    # Python NoneType traceback.
    local last_status
    last_status=$(curl -sS "$API_URL/cockpit/health/runs" \
        | python3 -c "
import sys, json
r = json.load(sys.stdin).get('data', {}).get('last')
print(r.get('status', '') if r else '')
")
    assert_eq "last.status from /health/runs" "$last_status" "ok"

    local last_scanned
    last_scanned=$(curl -sS "$API_URL/cockpit/health/runs" \
        | python3 -c "
import sys, json
r = json.load(sys.stdin).get('data', {}).get('last')
print(r.get('scanned', '') if r else '')
")
    assert_eq "last.scanned from /health/runs" "$last_scanned" "5"
}

# ---------------------------------------------------------------------
# T2.7 — Parity check against synthetic data.
# ---------------------------------------------------------------------
T2_7() {
    section "T2.7 — Parity check"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 2 --prs 20

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    # Run parity-check inside the worker container (no ts-node on host).
    if docker exec "$WORKER_CONTAINER" pnpm run analytics:parity-check --threshold 0.005 >/dev/null 2>&1; then
        pass "parity-check exit 0"
    else
        fail "parity-check exit non-zero"
    fi
}

# ---------------------------------------------------------------------
# T2.8 — Health endpoint is publicly reachable (no JWT).
# ---------------------------------------------------------------------
T2_8() {
    section "T2.8 — /cockpit/health is public"
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/cockpit/health")
    assert_eq "GET /cockpit/health returns 200" "$code" "200"
}

# ---------------------------------------------------------------------
# T2.9 — Trigger endpoint refuses without the env flag.
# Skipped by default because it requires restarting the API with the
# flag OFF, which we don't want in a local dev loop. Enable manually
# before a release if you want to assert the gate works.
# ---------------------------------------------------------------------
T2_9() {
    section "T2.9 — SKIPPED — manual gate verification"
    echo "  $(yellow 'SKIP') restart API without API_ANALYTICS_ALLOW_TRIGGER and curl /cockpit/admin/trigger-ingestion → 403"
}

# ---------------------------------------------------------------------
# T2.10 — Backfill chunked end-to-end. Validates the orchestrator's
# core promise: walk createdAt windows, persist checkpoint, seed the
# incremental watermark with the latest tuple seen. None of this had
# ever run against a real DB before this case existed.
# ---------------------------------------------------------------------
T2_10() {
    section "T2.10 — Backfill chunked end-to-end"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 4 --prs 50 --days 60   # 200 PRs spread across 60 days

    # Tight windows + small batches stress the loop without slowing the
    # suite down.
    backfill_http "?fresh=true&stepDays=7&pauseMs=100&batch=50" >/dev/null \
        || { fail "backfill endpoint unreachable"; return; }

    local pr_count
    pr_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt;")
    assert_eq "all PRs ingested via backfill" "$pr_count" "200"

    local bf_status
    bf_status=$(psql_q "SELECT status FROM analytics.backfill_progress WHERE source='pull_requests';")
    assert_eq "backfill_progress status = completed" "$bf_status" "completed"

    local wm_id
    wm_id=$(psql_q "SELECT last_source_id FROM analytics.watermarks WHERE table_name='pull_requests';")
    if [ -n "$wm_id" ]; then
        pass "incremental watermark seeded by orchestrator ($wm_id)"
    else
        fail "incremental watermark should be seeded after backfill completes"
    fi
}

# ---------------------------------------------------------------------
# T2.11 — Resume from checkpoint. Seeds 200 PRs over 60 days, injects a
# checkpoint at day -30 (midpoint), and re-runs the backfill. Must
# pick up from the cursor and not restart from epoch.
# ---------------------------------------------------------------------
T2_11() {
    section "T2.11 — Backfill resume from checkpoint"
    reset_warehouse
    reset_mongo_test_orgs
    seed --orgs 4 --prs 50 --days 60

    # Inject a "paused" checkpoint at the 30-day midpoint. Without
    # `--fresh`, the orchestrator must honor this cursor.
    psql_q "
        INSERT INTO analytics.backfill_progress (
            source, cursor_at, status, started_at, updated_at, scanned_total
        ) VALUES (
            'pull_requests',
            (now() - INTERVAL '30 days'),
            'paused', now(), now(), 100
        );
    " >/dev/null

    backfill_http "?stepDays=7&pauseMs=100&batch=50" >/dev/null \
        || { fail "backfill endpoint unreachable"; return; }

    # Synthetic data is uniform random over the window, so resuming at
    # the midpoint should ingest ~half (100 ± wide tolerance for randomness).
    # The point is: not 0 (didn't ignore checkpoint), not 200 (didn't
    # restart from epoch).
    local pr_count
    pr_count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt;")
    if [ "$pr_count" -ge 30 ] && [ "$pr_count" -le 170 ]; then
        pass "backfill resumed from midpoint checkpoint (got $pr_count, expected ~half)"
    else
        fail "backfill resume produced unexpected count=$pr_count (expected 30..170)"
    fi

    local bf_status
    bf_status=$(psql_q "SELECT status FROM analytics.backfill_progress WHERE source='pull_requests';")
    assert_eq "backfill_progress status after resume = completed" "$bf_status" "completed"
}

# ---------------------------------------------------------------------
# T2.12 — Schema drift defensive: the OTHER half of quarantine. T2.3
# tested that an UNPROCESSABLE doc lands in ingestion_errors. This
# checks that defensible drift (different shape but recoverable)
# ingests cleanly without producing garbage values like
# `"[object Object]"` in text columns.
# ---------------------------------------------------------------------
T2_12() {
    section "T2.12 — Schema drift defensive (no false quarantine, no garbage)"
    reset_warehouse
    reset_mongo_test_orgs

    # 3 known shape oddities the ingestion code handles defensively:
    #   drift-1: implementationStatus is an object {type, default: ...}
    #   drift-2: commit author is a bare string (not {username, name})
    #   drift-3: implementationStatus missing entirely
    mongo_eval "
        db.pullRequests.insertMany([
            {
                _id: ObjectId(), title: 'analytics-test-suite-drift-1', number: 70001,
                organizationId: '${ORG_PREFIX}-001',
                repository: { id: 'r1', fullName: 'o/r' },
                createdAt: new Date(), updatedAt: new Date(),
                files: [{
                    id: 'f1', path: 'a.ts', filename: 'a.ts',
                    suggestions: [{
                        id: 's1', label: 'bug', severity: 'high',
                        implementationStatus: { type: 'string', default: 'partially_implemented' },
                        deliveryStatus: 'sent', createdAt: new Date()
                    }]
                }],
                commits: []
            },
            {
                _id: ObjectId(), title: 'analytics-test-suite-drift-2', number: 70002,
                organizationId: '${ORG_PREFIX}-001',
                repository: { id: 'r1', fullName: 'o/r' },
                createdAt: new Date(), updatedAt: new Date(),
                files: [],
                commits: [{ sha: 'abc123', commit_timestamp: new Date().toISOString(), author: 'just-a-string' }]
            },
            {
                _id: ObjectId(), title: 'analytics-test-suite-drift-3', number: 70003,
                organizationId: '${ORG_PREFIX}-001',
                repository: { id: 'r1', fullName: 'o/r' },
                createdAt: new Date(), updatedAt: new Date(),
                files: [{
                    id: 'f1', path: 'b.ts', filename: 'b.ts',
                    suggestions: [{
                        id: 's2', label: 'security', severity: 'medium',
                        deliveryStatus: 'pending', createdAt: new Date()
                    }]
                }],
                commits: []
            }
        ])
    " >/dev/null

    trigger "" >/dev/null || { fail "trigger endpoint unreachable"; return; }

    # All 3 ingest (defense worked).
    local count
    count=$(psql_q "SELECT COUNT(*) FROM analytics.pull_requests_opt WHERE \"organizationId\" = '${ORG_PREFIX}-001';")
    assert_eq "all drift PRs ingested (no false-positive quarantine)" "$count" "3"

    local quarantined
    quarantined=$(psql_q "SELECT errors_quarantined FROM analytics.ingestion_runs ORDER BY id DESC LIMIT 1;")
    assert_eq "no quarantine on recoverable drift" "$quarantined" "0"

    # Defensive parsing must NEVER write JS object stringification into
    # text columns — that's silent data corruption.
    local bad_author
    bad_author=$(psql_q "SELECT COUNT(*) FROM analytics.commits_view WHERE author_username = '[object Object]';")
    assert_eq "no '[object Object]' in author_username" "$bad_author" "0"

    local bad_impl
    bad_impl=$(psql_q "SELECT COUNT(*) FROM analytics.suggestions_mv WHERE \"suggestionImplementationStatus\" = '[object Object]';")
    assert_eq "no '[object Object]' in suggestionImplementationStatus" "$bad_impl" "0"

    # The object-shaped implementationStatus from drift-1 should have
    # been parsed via the `default` key fallback, yielding a real value.
    local impl_value
    impl_value=$(psql_q "
        SELECT \"suggestionImplementationStatus\"
        FROM analytics.suggestions_mv
        WHERE \"organizationId\" = '${ORG_PREFIX}-001'
          AND suggestion_id = 's1';
    ")
    assert_eq "implementationStatus extracted from object via .default" \
        "$impl_value" "partially_implemented"
}

# ---------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------

ALL_TESTS=(T2_1 T2_2 T2_3 T2_4 T2_5 T2_6 T2_7 T2_8 T2_9 T2_10 T2_11 T2_12)

if [ $# -gt 0 ]; then
    REQUESTED=("$@")
else
    REQUESTED=("${ALL_TESTS[@]}")
fi

log "Starting test suite — API=$API_URL"
log "Tests: ${REQUESTED[*]}"

for t in "${REQUESTED[@]}"; do
    if declare -F "$t" >/dev/null; then
        "$t"
    else
        echo "$(red "unknown test: $t")"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
done

# Final cleanup so re-runs start clean.
section "Cleanup"
reset_warehouse
reset_mongo_test_orgs
log "warehouse + Mongo test orgs cleared"

echo
echo "$(yellow '━━━━━━━━━━━━━━━━━━━━━━━━━━━')"
echo "PASS: $(green "$PASS_COUNT")  FAIL: $(red "$FAIL_COUNT")"
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "Failed assertions:"
    for f in "${FAILED_TESTS[@]}"; do echo "  - $f"; done
    exit 1
fi
exit 0
