#!/usr/bin/env bash
#
# Incremental mutation gate. Runs Stryker on ONLY the production .ts files this
# branch changed versus its merge-base with the base branch — the sensor a PR
# can afford, versus mutating the whole repo (minutes per file).
#
# Why a diff scope: a full-repo mutation run is too slow to gate on. Scoping to
# the changed files answers the question that actually matters on a PR — "are the
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
mapfile -t FILES < <(
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

# Scope the dry run to the co-located specs of the changed files. Stryker's dry
# run runs the whole configured testMatch; without this it would run the manual
# default list (jest.stryker.config.ts) instead of the tests that actually cover
# THESE files. jest.stryker.config.ts reads STRYKER_JEST_TESTMATCH when set.
SPECS=()
for f in "${FILES[@]}"; do
    b="${f%.ts}"
    for cand in "${b}.spec.ts" "${b}.test.ts" "${b}.input-contract.spec.ts"; do
        [ -f "$cand" ] && SPECS+=("<rootDir>/${cand}")
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

# Comma-join for Stryker's --mutate (overrides the config's mutate list).
MUTATE="$(IFS=,; echo "${FILES[*]}")"

exec npx stryker run --mutate "$MUTATE"
