#!/usr/bin/env bash
# Warn the dev if .env-relevant files changed in a pull/checkout and the
# local .env may be stale (i.e. you forgot to run `pnpm run env:pull`).
#
# Runs from .husky/post-merge and .husky/post-checkout — must exit 0 even
# on errors so the git operation never blocks.
#
# Args (passed by post-checkout): $1=prev_HEAD $2=new_HEAD $3=is_branch
# post-merge passes no args — we default to HEAD@{1}..HEAD.

set +e  # never fail the hook

# Don't use ${VAR:-HEAD@{1}} — the inner `}` of `HEAD@{1}` closes the
# outer parameter expansion and bash mis-parses the default. Assign
# defaults the old-fashioned way.
OLD="$1"
NEW="$2"
[[ -z "$OLD" ]] && OLD="HEAD@{1}"
[[ -z "$NEW" ]] && NEW="HEAD"

# Files that mean "your .env is now out of date".
WATCH='\.env\.schema|\.env\.template|\.env\.example'

CHANGED=$(git diff --name-only "$OLD" "$NEW" 2>/dev/null | grep -E "^($WATCH)$")

if [[ -z "$CHANGED" ]]; then
    exit 0
fi

# ANSI yellow if stdout is a TTY, plain otherwise.
if [[ -t 1 ]]; then
    Y="\033[1;33m"; B="\033[1;36m"; N="\033[0m"
else
    Y=""; B=""; N=""
fi

printf "\n${Y}⚠  Schema or env templates changed in this update:${N}\n"
echo "$CHANGED" | sed 's/^/   • /'
printf "\n   ${B}Run \`pnpm run env:pull\`${N} to regenerate your local .env.\n\n"

exit 0
