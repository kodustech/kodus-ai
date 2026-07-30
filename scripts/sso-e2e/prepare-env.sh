#!/usr/bin/env bash
# Sanitize .env for use with `docker --env-file`, which (unlike a real
# shell or docker-compose) chokes on:
#   1. Multi-line values quoted across newlines (the BEGIN/END RSA PEM
#      block in API_GITHUB_PRIVATE_KEY).
#   2. Inline `# comment` after a value (cron expressions like
#      `5 5 * * *  # at 05:05` get the comment baked into the value,
#      which then fails cron parsing with "Unknown alias: a").
#
# Outputs `.tmp/sso-e2e-api.env` — what `docker-compose.yml` reads via
# env_file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="${REPO_ROOT}/.env"
DEST="${REPO_ROOT}/.tmp/sso-e2e-api.env"

if [ ! -f "${SOURCE}" ]; then
    echo "error: ${SOURCE} not found — run \`pnpm run env:apply\` first" >&2
    exit 1
fi

mkdir -p "${REPO_ROOT}/.tmp"

awk '
    # Drop the multi-line API_GITHUB_PRIVATE_KEY="…\n…\n…" block.
    /^API_GITHUB_PRIVATE_KEY="/                       { skip=1; next }
    skip && /-----END RSA PRIVATE KEY-----"/          { skip=0; next }
    skip                                              { next }

    # Promote the commented one-line variant to active.
    /^# API_GITHUB_PRIVATE_KEY=/                      { sub(/^# /, ""); print; next }

    # Strip inline `  # comment` from any KEY=VAL line.
    /^[A-Z_][A-Z0-9_]*=/                              { sub(/[[:space:]]+#.*$/, ""); print; next }

    { print }
' "${SOURCE}" > "${DEST}"

echo "wrote ${DEST}"
