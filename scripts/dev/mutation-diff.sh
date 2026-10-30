#!/usr/bin/env bash
#
# Incremental mutation gate. Runs Stryker on changed lines of production .ts
# files versus the merge-base with the base branch.
#
# Why a diff scope: a full-repo mutation run is too slow to gate on. Scoping to
# the changed lines answers the question that actually matters on a PR — "are the
# lines THIS change touched covered by an assertion, or just executed?" — in the
# time budget of a normal check.
#
# Usage:
#   scripts/dev/mutation-diff.sh [base-ref]     # base-ref defaults to origin/main
#
# Exit code is Stryker's: non-zero when the mutation score is below the
# thresholds.break in stryker.config.json, so this can gate a hook or CI job.
set -euo pipefail

BASE_REF="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

# merge-base, not a raw diff: we want what this branch introduced, not files that
# merely moved on the base branch since we forked.
MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")"

# Changed production TS: exclude specs/tests (mutating a test is meaningless) and
# type-only declaration files (no runtime logic to mutate). Include unstaged work
# so the sensor runs pre-commit, not just post-push.
changed_paths="$(
    git diff --name-only --diff-filter=ACMR "$MERGE_BASE"...HEAD &&
    git diff --name-only --diff-filter=ACMR HEAD
)" || { echo "[mutation:diff] Could not list changed files." >&2; exit 1; }

FILES=()
while IFS= read -r file; do
    [[ "$file" == apps/* || "$file" == libs/* ]] || continue
    # apps/cli runs its own vitest suite; the root jest Stryker drives can't.
    [[ "$file" == apps/cli/* ]] && continue
    [[ "$file" == *.ts ]] || continue
    [[ "$file" =~ \.(spec|test|integration)\.ts$ ]] && continue
    [[ "$file" == *.d.ts ]] && continue
    [[ "$file" =~ ^(node_modules|dist|coverage|\.stryker-tmp)/ ]] && continue
    [ -f "$file" ] && FILES+=("$file")
done < <(printf '%s\n' "$changed_paths" | sort -u)

if [ -z "${FILES[0]-}" ]; then
    echo "[mutation:diff] No changed production .ts files vs ${BASE_REF} — nothing to mutate."
    exit 0
fi

# Changed files no scoped spec reaches go to the report instead of out of the
# score: the CI shard puts this list in its status.json for the aggregator.
UNREACHED_PATH="reports/mutation/unreached.json"
rm -f "$UNREACHED_PATH"
record_unreached() {
    mkdir -p "${UNREACHED_PATH%/*}"
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "$UNREACHED_PATH" "$@"
}

echo "[mutation:diff] Mutating ${#FILES[@]} changed file(s) vs ${MERGE_BASE}:"
printf '  - %s\n' "${FILES[@]}"

# Both Stryker's --mutate and jest's testMatch read these paths as globs, so a
# Next.js route segment like `(app)/[repositoryId]` would be a character class
# and match nothing. Wrap each glob metacharacter in a one-character class
# (`[` -> `[[]`): a backslash escape doesn't survive Stryker, which normalizes
# `\` to `/` before matching.
glob_escape() { printf '%s' "$1" | sed -e 's/[][()*?{}]/[&]/g'; }

# Scope the dry run to nearby specs of the changed files. Stryker's dry
# run runs the whole configured testMatch; without this it would run the manual
# default list (jest.stryker.config.ts) instead of the tests that actually cover
# THESE files. jest.stryker.config.ts reads STRYKER_JEST_TESTMATCH when set.
SPECS=()
add_spec() {
    [ -f "$1" ] || return 0
    local escaped="<rootDir>/$(glob_escape "$1")"
    for existing in "${SPECS[@]-}"; do
        [ "$existing" = "$escaped" ] && return 0
    done
    SPECS+=("$escaped")
}

for f in "${FILES[@]}"; do
    directory="${f%/*}"
    stem="${f##*/}"
    stem="${stem%.ts}"
    prefix="${stem%%.*}"
    # Only `.spec.ts`: the root jest's testMatch. A `.test.ts` is vitest
    # (apps/cli) or e2e, and jest fails the dry run on it.
    for cand in \
        "${directory}/${stem}"*.spec.ts \
        "${directory}/${prefix}"*.spec.ts \
        "${directory}/__tests__/${stem}"*.spec.ts \
        "${directory}/__tests__/${prefix}"*.spec.ts; do
        add_spec "$cand"
    done
done

# Naming misses a spec that reaches a file through another module (a mapper
# tested through its index), so the specs jest's dependency graph relates to
# the changed files are added too, nearest first and capped: a hub file relates
# to hundreds of specs.
MAX_RELATED_SPECS="${MUTATION_MAX_RELATED_SPECS:-40}"
related_specs="$(node scripts/dev/mutation-related-specs.cjs "$MAX_RELATED_SPECS" "${FILES[@]}")" || {
    echo "[mutation:diff] Could not list the specs related to the changed files." >&2
    exit 1
}
while IFS= read -r spec; do
    [ -n "$spec" ] && add_spec "$spec"
done <<< "$related_specs"

if [ -z "${SPECS[0]-}" ]; then
    echo "[mutation:diff] None of the changed files have a nearby spec — nothing to validate."
    echo "                (That is itself a signal: this change added/edited untested production code.)"
    record_unreached "${FILES[@]}"
    exit 0
fi

# Emit the spec list as a JSON array for jest.stryker.config.ts (node does the
# quoting so a path with odd characters can't corrupt it).
export STRYKER_JEST_TESTMATCH="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "${SPECS[@]}")"
echo "[mutation:diff] Scoping tests to ${#SPECS[@]} nearby spec(s)."

# Stryker supports literal-file mutation ranges, but cannot combine ranges with
# glob syntax. Next.js route paths contain glob characters, so keep those files
# as whole-file globs; normal paths use each added/changed diff hunk. Deleted-only
# hunks have no current lines to mutate.
MUTATE_GLOBS=()
for f in "${FILES[@]}"; do
    case "$f" in
        *"["*|*"]"*|*"("*|*")"*|*"*"*|*"?"*|*"{"*|*"}"*)
            MUTATE_GLOBS+=("$(glob_escape "$f")")
            continue
            ;;
    esac

    patch="$(git diff --no-ext-diff --no-renames --unified=0 "$MERGE_BASE" -- "$f")" || {
        echo "[mutation:diff] Could not read changed lines for $f." >&2
        exit 1
    }
    ranges="$(printf '%s\n' "$patch" | sed -nE 's/^@@ .* \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p')"
    while read -r start count; do
        [ -n "$start" ] || continue
        count="${count:-1}"
        [ "$count" -gt 0 ] || continue
        MUTATE_GLOBS+=("${f}:${start}-$((start + count - 1))")
    done <<< "$ranges"
done

if [ -z "${MUTATE_GLOBS[0]-}" ]; then
    echo "[mutation:diff] Changed files have no current lines to mutate."
    exit 0
fi

SHARD_INDEX="${MUTATION_SHARD_INDEX:-0}"
SHARD_COUNT="${MUTATION_SHARD_COUNT:-1}"
MUTATE="$(node scripts/dev/mutation-shard.cjs "$SHARD_INDEX" "$SHARD_COUNT" "${MUTATE_GLOBS[@]}")"
if [ -z "$MUTATE" ]; then
    echo "[mutation:diff] Shard ${SHARD_INDEX}/${SHARD_COUNT} has no changed lines."
    exit 0
fi
echo "[mutation:diff] Mutating shard ${SHARD_INDEX}/${SHARD_COUNT} from ${#MUTATE_GLOBS[@]} changed range(s)/file(s)."

# Stryker runs only the scoped specs related to this shard's files
# (enableFindRelatedTests) and aborts with "No tests were executed" when there
# are none. Ask jest the same question first, so such a shard reports it.
# jest takes literal paths: a route file's selector is its escaped glob, so the
# shard's files are the changed files whose selector landed in it.
SHARD_FILES=()
IFS=',' read -r -a shard_selectors <<< "$MUTATE"
for f in "${FILES[@]}"; do
    escaped="$(glob_escape "$f")"
    for selector in "${shard_selectors[@]}"; do
        if [ "$selector" = "$escaped" ] || [ "${selector%%:*}" = "$f" ]; then
            SHARD_FILES+=("$f")
            break
        fi
    done
done
# jest exits 0 with an empty list when nothing relates; any other exit is a
# discovery failure and fails the shard with jest's own diagnostic.
if ! shard_specs="$(node node_modules/jest/bin/jest.js -c jest.stryker.config.ts \
    --listTests --findRelatedTests "${SHARD_FILES[@]}")"; then
    echo "[mutation:diff] Shard ${SHARD_INDEX}/${SHARD_COUNT}: jest could not list the specs for these files." >&2
    exit 1
fi
if [ -z "$shard_specs" ]; then
    echo "[mutation:diff] Shard ${SHARD_INDEX}/${SHARD_COUNT}: no scoped spec reaches these files — nothing to validate:"
    printf '  - %s\n' "${SHARD_FILES[@]}"
    record_unreached "${SHARD_FILES[@]}"
    exit 0
fi

exec npx stryker run --mutate "$MUTATE"
