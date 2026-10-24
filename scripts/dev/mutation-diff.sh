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
FILES=()
while IFS= read -r file; do FILES+=("$file"); done < <(
    {
        git diff --name-only --diff-filter=ACMR "$MERGE_BASE"...HEAD
        git diff --name-only --diff-filter=ACMR HEAD
    } \
        | sort -u \
        | grep -E '\.ts$' \
        | grep -vE '\.(spec|test|integration)\.ts$' \
        | grep -vE '\.d\.ts$' \
        | grep -vE '^(node_modules|dist|coverage|\.stryker-tmp)/' \
        | while read -r f; do [ -f "$f" ] && echo "$f"; done
)

if [ "${#FILES[@]}" -eq 0 ]; then
    echo "[mutation:diff] No changed production .ts files vs ${BASE_REF} — nothing to mutate."
    exit 0
fi

echo "[mutation:diff] Mutating ${#FILES[@]} changed file(s) vs ${MERGE_BASE}:"
printf '  - %s\n' "${FILES[@]}"

# Both Stryker's --mutate and jest's testMatch read these paths as globs, so a
# Next.js route segment like `(app)/[repositoryId]` would be a character class
# and match nothing. Wrap each glob metacharacter in a one-character class
# (`[` -> `[[]`): a backslash escape doesn't survive Stryker, which normalizes
# `\` to `/` before matching.
glob_escape() { printf '%s' "$1" | sed -e 's/[][()*?{}]/[&]/g'; }

# Scope the dry run to the co-located specs of the changed files. Stryker's dry
# run runs the whole configured testMatch; without this it would run the manual
# default list (jest.stryker.config.ts) instead of the tests that actually cover
# THESE files. jest.stryker.config.ts reads STRYKER_JEST_TESTMATCH when set.
SPECS=()
for f in "${FILES[@]}"; do
    b="${f%.ts}"
    for cand in "${b}.spec.ts" "${b}.test.ts" "${b}.input-contract.spec.ts"; do
        [ -f "$cand" ] && SPECS+=("<rootDir>/$(glob_escape "$cand")")
    done
done

if [ "${#SPECS[@]}" -eq 0 ]; then
    echo "[mutation:diff] None of the changed files have a co-located spec — nothing to validate."
    echo "                (That is itself a signal: this change added/edited untested production code.)"
    exit 0
fi

# Emit the spec list as a JSON array for jest.stryker.config.ts (node does the
# quoting so a path with odd characters can't corrupt it).
export STRYKER_JEST_TESTMATCH="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "${SPECS[@]}")"
echo "[mutation:diff] Scoping tests to ${#SPECS[@]} co-located spec(s)."

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

    while read -r start count; do
        [ -n "$start" ] || continue
        count="${count:-1}"
        [ "$count" -gt 0 ] || continue
        MUTATE_GLOBS+=("${f}:${start}-$((start + count - 1))")
    done < <(
        git diff --no-ext-diff --no-renames --unified=0 "$MERGE_BASE" -- "$f" \
            | sed -nE 's/^@@ .* \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p'
    )
done

if [ "${#MUTATE_GLOBS[@]}" -eq 0 ]; then
    echo "[mutation:diff] Changed files have no current lines to mutate."
    exit 0
fi

echo "[mutation:diff] Mutating ${#MUTATE_GLOBS[@]} changed range(s)/file(s)."
MUTATE="$(IFS=,; echo "${MUTATE_GLOBS[*]}")"

exec npx stryker run --mutate "$MUTATE"
