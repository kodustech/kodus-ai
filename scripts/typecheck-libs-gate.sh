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

echo "✅ No TS2304 (undeclared name) errors in libs/."
