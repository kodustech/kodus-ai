#!/usr/bin/env bash
# Tear down a Kodus SSO E2E droplet provisioned by provision.sh.
#
# Thin wrapper around scripts/selfhosted/destroy.sh — the droplet is
# just a self-hosted instance with the SSO E2E overlay layered on top.
# Removing the droplet wipes the overlay containers + Caddy + Keycloak
# alongside the base stack.
#
# Usage:
#   pnpm run sso-e2e:droplet:destroy                    # default instance
#   pnpm run sso-e2e:droplet:destroy --name <name>      # named instance

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

NAME_RAW="${SSO_E2E_DROPLET_NAME:-sso-e2e}"
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

# Clean up state files local to this test before destroying the droplet,
# so a stale orgId / TLS flag from a previous run can't leak into the
# next provision cycle.
rm -f \
    "${REPO_ROOT}/.tmp/sso-e2e-droplet.json" \
    "${REPO_ROOT}/.tmp/sso-e2e-droplet-keycloak.json" \
    "${REPO_ROOT}/.tmp/sso-e2e-org-id.txt"

exec "${REPO_ROOT}/scripts/selfhosted/destroy.sh" --name "${NAME_RAW}"
