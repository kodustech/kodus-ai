#!/usr/bin/env bash
#
# CI gate: fail a PR only on TS2304 ("Cannot find name") errors under libs/.
#
# This is the dangling-reference class that shipped the dedup `googleKey`
# ReferenceError on a feature branch: the repo's build transpiles WITHOUT
# type-checking (jest/SWC), so an undeclared reference reaches runtime as a
# silent degrade instead of a compile failure. `tsc --noEmit` catches it, but no
# CI step ran it.
#
# The repo is NOT fully type-clean — apps/web carries a large pre-existing
# backlog — so this is a SCOPED, high-signal gate, not a blanket `tsc` green.
# It catches exactly the runtime-bomb class. Widen the scope (more codes, more
# paths) as libs/ is cleaned up.
set -uo pipefail

# `tsc` exits non-zero whenever ANY error exists (including the pre-existing
# frontend backlog), so ignore its exit code and inspect the output instead.
output="$(pnpm --silent typecheck 2>&1 || true)"

violations="$(printf '%s\n' "$output" | grep -E '^libs/.*\): error TS2304' || true)"

if [ -n "$violations" ]; then
    count="$(printf '%s\n' "$violations" | grep -c .)"
    echo "❌ ${count} undeclared-name (TS2304) error(s) in libs/ — these become"
    echo "   runtime ReferenceErrors that ship as silent failures:"
    echo ""
    printf '%s\n' "$violations"
    echo ""
    echo "Fix the undeclared reference(s) above. (Gate scope: TS2304 under libs/.)"
    exit 1
fi

# ── Clean zone ──────────────────────────────────────────────────────────────
#
# TS2304 alone is too narrow. Two type errors in libs/llm reached the author's
# editor while this gate reported green: a `TemperaturePolicy` imported from a
# module that only re-declares it (TS2459), and a `.min` read off a union whose
# other arm is an array of levels (TS2339, a `thinkingBudget: NaN` on the wire).
# Jest transpiles with SWC and never type-checks, so nothing else would catch
# them.
#
# So libs/llm is a ZERO-ERROR zone. It is small, and it is where BYOK correctness
# lives. There is no allowlist: the four pre-existing specs this gate started
# with have been fixed, so the rule is simply that libs/ have no type errors.
CLEAN_PATH='^libs/llm/'

clean_zone="$(printf '%s\n' "$output" \
    | grep -E "${CLEAN_PATH}.*\): error TS" || true)"

if [ -n "$clean_zone" ]; then
    count="$(printf '%s\n' "$clean_zone" | grep -c .)"
    echo "❌ ${count} type error(s) in the libs/llm clean zone:"
    echo ""
    printf '%s\n' "$clean_zone"
    echo ""
    echo "libs/llm must type-check cleanly. (Gate scope: all TS codes under libs/llm,"
    echo " plus TS2304 under libs/.)"
    exit 1
fi

echo "✅ No TS2304 (undeclared name) errors in libs/, and libs/llm type-checks clean."
