#!/usr/bin/env bash
#
# Safe, on-demand mutation gate for a single file.
#
# WHY THIS EXISTS: the base stryker.config.json runs `inPlace: true`, which
# rewrites the real source files on disk while it runs (it injects `// @ts-nocheck`
# and blanks `// @ts-ignore`/`// @ts-expect-error`). If such a run is interrupted
# (machine sleeps, process killed) it leaves the working tree corrupted across
# the whole repo. This wrapper forces SANDBOX mode (`inPlace: false`): Stryker
# copies the project into .stryker-tmp and mutates THERE, so your working tree is
# never touched — even if the run dies. It also keeps the machine awake and
# always cleans .stryker-tmp on exit.
#
# Usage:
#   pnpm mutation:file <path/to/file.ts> [lineStart-lineEnd]
# Examples:
#   pnpm mutation:file libs/llm/token-estimate.ts
#   pnpm mutation:file libs/code-review/.../suggestion.service.ts 1098-1212
#
set -euo pipefail

TARGET="${1:-}"
RANGE="${2:-}"
if [ -z "$TARGET" ]; then
    echo "usage: pnpm mutation:file <path/to/file.ts> [lineStart-lineEnd]" >&2
    exit 2
fi
if [ ! -f "$TARGET" ]; then
    echo "file not found: $TARGET" >&2
    exit 2
fi

SPEC="${TARGET%.ts}.spec.ts"
if [ ! -f "$SPEC" ]; then
    echo "no co-located spec next to the target: $SPEC" >&2
    echo "(the gate needs the test file that exercises this source)" >&2
    exit 2
fi

# Sandbox-mode config derived from the base one, with inPlace forced off.
SAFE_CONFIG="$(mktemp -t stryker-safe-XXXXXX).json"
node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync("stryker.config.json", "utf8"));
  cfg.inPlace = false;               // NEVER edit the real working tree
  cfg.cleanTempDir = true;
  // Keep the sandbox copy tiny: skip heavy non-source trees so the copy is fast
  // and never fills the disk (docs dossiers, worktrees, build output, caches).
  cfg.ignorePatterns = [
    ...(cfg.ignorePatterns || []),
    "docs-internal", "docs", ".worktrees", "dist", ".agents",
    "coverage", "reports", ".next", "apps/*/.next", ".planning",
    "**/*.hot-update.*",
  ];
  fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2));
' "$SAFE_CONFIG"

cleanup() {
    rm -rf .stryker-tmp
    rm -f "$SAFE_CONFIG"
}
trap cleanup EXIT INT TERM

MUTATE="$TARGET"
if [ -n "$RANGE" ]; then
    MUTATE="$TARGET:$RANGE"
fi

# Keep the machine awake for the duration (macOS). No-op elsewhere.
CAFFEINATE=""
if command -v caffeinate >/dev/null 2>&1; then
    CAFFEINATE="caffeinate -i"
fi

echo "▶ mutation gate (sandbox mode — working tree is never modified)"
echo "  target: $MUTATE"
echo "  spec:   $SPEC"
echo ""

STRYKER_JEST_TESTMATCH="[\"<rootDir>/$SPEC\"]" \
    $CAFFEINATE npx stryker run "$SAFE_CONFIG" --mutate "$MUTATE"
