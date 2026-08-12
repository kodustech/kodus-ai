#!/usr/bin/env bash
# Append this run's results to the durable history log and push it.
#
# The log lives on an ORPHAN BRANCH (default `e2e-history`) in this repo --
# not in the product database, and not in a table that ships to self-hosted
# installs. CI results are CI data. An orphan branch also needs no new
# secret: GITHUB_TOKEN with `contents: write` on this job is enough, whereas
# a gist would require a separate PAT.
#
# Idempotent and concurrency-safe: on a rejected push we re-fetch, re-apply
# our rows on top, and retry -- two matrices finishing at once must not lose
# one of their runs.
#
# Never FAILS the job -- a reporting gap is not a release gate -- but every
# no-op path emits a ::warning:: so it is visible in the run summary. A silent
# green here would be the same disease this whole change is fixing: the first
# real run reported "Append run to e2e history: success" while pushing
# nothing, because the cells had died before writing any evidence.
set -uo pipefail

cd "$(dirname "$0")/../../.." # repo root

BRANCH="${E2E_HISTORY_BRANCH:-e2e-history}"
FILE="history/e2e-history.jsonl"
E2E_DIR="tests/e2e"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -z "${GITHUB_ACTIONS:-}" ] && [ -z "${E2E_HISTORY_FORCE_PUSH:-}" ]; then
    echo "[history] not in CI -- skipping push (set E2E_HISTORY_FORCE_PUSH=1 to override)"
    exit 0
fi

# Build this run's rows into a standalone file first, so the retry loop can
# re-apply them onto a freshly fetched branch without re-reading evidence.
ROWS="$TMP/rows.jsonl"
( cd "$E2E_DIR" && ./node_modules/.bin/tsx cli/history-append.ts --history "$ROWS" ) \
    || { echo "::warning::[history] history-append.ts failed -- no rows pushed for this run"; exit 0; }

if [ ! -s "$ROWS" ]; then
    echo "::warning::[history] no rows produced -- the matrix wrote no evidence (cells likely died before running), so this run leaves no trace in the history log"
    exit 0
fi

git config user.name  "kodus-e2e-bot"
git config user.email "e2e@kodus.io"

for attempt in 1 2 3; do
    rm -rf "$TMP/wt"
    if git fetch origin "$BRANCH" --depth=1 2>/dev/null; then
        git worktree add --detach "$TMP/wt" FETCH_HEAD >/dev/null 2>&1 || {
            echo "::warning::[history] worktree add failed -- run not recorded"; exit 0; }
    else
        # First ever run: create the orphan branch from nothing.
        echo "[history] branch $BRANCH does not exist yet -- creating it"
        git worktree add --detach "$TMP/wt" >/dev/null 2>&1 || exit 0
        ( cd "$TMP/wt" && git checkout --orphan "$BRANCH" >/dev/null 2>&1 && git rm -rfq --cached . 2>/dev/null; rm -rf "$TMP/wt"/* )
    fi

    mkdir -p "$TMP/wt/$(dirname "$FILE")"
    touch "$TMP/wt/$FILE"
    cat "$ROWS" >> "$TMP/wt/$FILE"

    (
        cd "$TMP/wt"
        git add "$FILE"
        git -c commit.gpgsign=false commit -q -m "e2e history: ${GITHUB_RUN_ID:-local} ($(wc -l < "$FILE" | tr -d ' ') rows)" 2>/dev/null
        git push -q origin "HEAD:$BRANCH" 2>&1
    ) && { echo "[history] pushed $(wc -l < "$ROWS" | tr -d ' ') row(s) to $BRANCH"; git worktree remove --force "$TMP/wt" 2>/dev/null; exit 0; }

    echo "[history] push attempt $attempt rejected (concurrent run?) -- retrying"
    git worktree remove --force "$TMP/wt" 2>/dev/null
    sleep $((attempt * 3))
done

echo "::warning::[history] could not push after 3 attempts -- this run is missing from the history log (results are still in the artifact)"
exit 0
