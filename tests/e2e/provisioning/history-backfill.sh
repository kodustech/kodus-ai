#!/usr/bin/env bash
# Seed the durable history log from the CI artifacts that still exist.
#
# The matrix has always written result.json into an artifact -- it just
# expires (14-30 days) and cannot be queried across runs. This pulls whatever
# is still there into history/e2e-history.jsonl so `e2e:report` has something
# to show on day one instead of waiting a month to become useful.
#
# One-shot by design: after this, every run appends its own rows via
# history-push.sh. Re-running is safe (rows are de-duplicated by runId).
#
# usage: tests/e2e/provisioning/history-backfill.sh [max_artifacts]
set -euo pipefail

cd "$(dirname "$0")/.."

REPO="${GH_REPO:-kodustech/kodus-ai}"
MAX="${1:-60}"
HISTORY_FILE="${E2E_HISTORY_FILE:-history/e2e-history.jsonl}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v gh >/dev/null || { echo "gh CLI required" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip required" >&2; exit 1; }

mkdir -p "$(dirname "$HISTORY_FILE")"
touch "$HISTORY_FILE"

# runIds already in the log -- so a re-run doesn't double-count.
SEEN="$TMP/seen.txt"
node -e '
  const fs=require("fs");
  const ids=new Set();
  for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) {
    if (!l.trim()) continue;
    try { ids.add(JSON.parse(l).runId); } catch {}
  }
  console.log([...ids].join("\n"));
' "$HISTORY_FILE" > "$SEEN"

echo "Backfilling from up to $MAX e2e artifacts on $REPO..."

gh api "/repos/$REPO/actions/artifacts?per_page=100" \
    --jq ".artifacts[] | select(.name|test(\"^e2e-\")) | select(.name|test(\"dry-run\")|not) | select(.expired==false) | \"\(.id)\t\(.name)\t\(.workflow_run.id)\"" \
    | head -n "$MAX" > "$TMP/list.tsv"

count=0
while IFS=$'\t' read -r id name run_id; do
    [ -z "${id:-}" ] && continue
    if ! gh api "/repos/$REPO/actions/artifacts/$id/zip" > "$TMP/a.zip" 2>/dev/null; then
        echo "  skip $name ($id): download failed"
        continue
    fi
    rm -rf "$TMP/x" && mkdir -p "$TMP/x"
    unzip -qo "$TMP/a.zip" -d "$TMP/x" 2>/dev/null || { echo "  skip $name: not a zip"; continue; }

    # An artifact holds one or more evidence/<runId>/ directories.
    while IFS= read -r result; do
        [ -z "$result" ] && continue
        dir="$(dirname "$result")"
        run_key="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runId||"")' "$result")"
        if [ -n "$run_key" ] && grep -qxF "$run_key" "$SEEN" 2>/dev/null; then
            continue
        fi
        GITHUB_RUN_ID="$run_id" \
        ./node_modules/.bin/tsx cli/history-append.ts \
            --evidence "$dir" \
            --history "$HISTORY_FILE" \
            --matrix-id "$(printf '%s' "$name" | sed 's/^e2e-//')" >/dev/null
        [ -n "$run_key" ] && echo "$run_key" >> "$SEEN"
        count=$((count + 1))
    done < <(find "$TMP/x" -name result.json)
done < "$TMP/list.tsv"

# Keep the log sorted by timestamp so appends stay roughly chronological.
sort -t'"' -k4 "$HISTORY_FILE" -o "$HISTORY_FILE" 2>/dev/null || true

echo "Backfilled $count run(s) -> $HISTORY_FILE"
echo "Now run: pnpm --dir tests/e2e run report"
