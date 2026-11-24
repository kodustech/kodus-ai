#!/usr/bin/env bash
#
# Undo the local test harness for the pr-decision-orchestrator change.
#
# The end-to-end verification runs Kodus inside WSL2 against a self-hosted
# Gitea on the local network. The git host pushes webhooks to Kodus, and
# WSL2's NAT blocks inbound connections from the LAN, so the webhooks
# service is published through the Windows host.
#
# That setup lives in THREE places, and only one of them is a file git
# knows about:
#
#   1. the Windows host  — a port forward and a firewall rule (machine state)
#   2. the Gitea instance — a PAT and a disposable repository (remote state)
#   3. this repository   — .env (gitignored, but still worth restoring)
#
# So `git checkout` cannot undo this. It has to be done on purpose.
# This script reports what is currently set and undoes it.
#
# Usage:
#   ./scripts/dev/cleanup-local-test-harness.sh          # report only
#   ./scripts/dev/cleanup-local-test-harness.sh --apply  # undo it
#
# The Windows half needs an Administrator PowerShell; without elevation the
# port-forward removal is skipped and reported, rather than failing silently.

set -uo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

WEBHOOK_PORT="${WEBHOOK_PORT:-3332}"
FIREWALL_RULE_NAME="${FIREWALL_RULE_NAME:-Kodus webhooks}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The addresses the local test harness used. They are specific to one
# machine, so they are supplied from the environment rather than baked in:
#   TEST_GIT_HOST       the git host the webhooks are pushed to
#   TEST_FORWARD_IP     the address the git host dials (the Windows host)
#   TEST_WSL_IP         the WSL2 address the forward points at
#   TEST_REPO_URL       the disposable repository
#   TEST_TOKEN_URL      the page where the PAT is created
#
# The tracked-file scan uses whatever is set here; with none of it set, it
# scans for nothing, which is the safe default for a shared script.
TEST_GIT_HOST="${TEST_GIT_HOST:-}"
TEST_FORWARD_IP="${TEST_FORWARD_IP:-}"
TEST_WSL_IP="${TEST_WSL_IP:-}"
TEST_REPO_URL="${TEST_REPO_URL:-}"
TEST_TOKEN_URL="${TEST_TOKEN_URL:-}"

ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
WEBHOOK_KEY="API_FORGEJO_CODE_MANAGEMENT_WEBHOOK"

fail=0

echo "Local test-harness cleanup (pr-decision-orchestrator)"
echo

# ---------------------------------------------------------------------------
# 1. Windows port forward
# ---------------------------------------------------------------------------
echo "1. Windows port forward (netsh interface portproxy, port ${WEBHOOK_PORT})"

if command -v powershell.exe >/dev/null 2>&1; then
    # The table prints "Address Port Address Port"; the listen address and
    # port are the FIRST pair, so match on the port alone.
    existing="$(powershell.exe -NoProfile -Command \
        "netsh interface portproxy show all" 2>/dev/null | tr -d '\r' | grep -E "^[0-9.]+\s+${WEBHOOK_PORT}\s" || true)"

    if [[ -z "$existing" ]]; then
        echo "   nothing forwarded — nothing to undo"
    elif [[ $APPLY -eq 1 ]]; then
        powershell.exe -NoProfile -Command \
            "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${WEBHOOK_PORT}" \
            >/dev/null 2>&1
        if [[ $? -eq 0 ]]; then
            echo "   removed"
        else
            echo "   FAILED — needs an Administrator PowerShell"
            fail=1
        fi
    else
        echo "   found (would remove):"
        echo "$existing" | sed 's/^/     /'
    fi
else
    echo "   SKIPPED — powershell.exe not found (not a Windows host?)"
fi
echo

# ---------------------------------------------------------------------------
# 2. Windows firewall rule
# ---------------------------------------------------------------------------
echo "2. Windows firewall rule (\"${FIREWALL_RULE_NAME}\")"

if command -v powershell.exe >/dev/null 2>&1; then
    present="$(powershell.exe -NoProfile -Command \
        "Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty DisplayName" \
        2>/dev/null | tr -d '\r' | grep -v '^$' || true)"

    if [[ -z "$present" ]]; then
        echo "   no rule — nothing to undo"
    elif [[ $APPLY -eq 1 ]]; then
        powershell.exe -NoProfile -Command \
            "Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}'" >/dev/null 2>&1
        if [[ $? -eq 0 ]]; then
            echo "   removed"
        else
            echo "   FAILED — needs an Administrator PowerShell"
            fail=1
        fi
    else
        echo "   found (would remove): ${present}"
    fi
else
    echo "   SKIPPED — powershell.exe not found (not a Windows host?)"
fi
echo

# ---------------------------------------------------------------------------
# 3. .env webhook URL
# ---------------------------------------------------------------------------
echo "3. Test-only keys in .env"

if [[ -f "$ENV_FILE" && -f "$ENV_EXAMPLE" ]]; then
    # The webhook URL has a documented default in .env.example; the rest are
    # test-only keys with no upstream counterpart, so they are removed
    # outright rather than restored.
    current="$(grep -E "^${WEBHOOK_KEY}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    expected="$(grep -E "^${WEBHOOK_KEY}=" "$ENV_EXAMPLE" | head -1 | cut -d= -f2-)"

    if [[ "$current" == "$expected" ]]; then
        echo "   ${WEBHOOK_KEY}: already the .env.example value — nothing to undo"
    elif [[ $APPLY -eq 1 ]]; then
        tmp="$(mktemp)"
        awk -v key="$WEBHOOK_KEY" -v val="$expected" '
            $0 ~ "^" key "=" { print key "=" val; next }
            { print }
        ' "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
        echo "   ${WEBHOOK_KEY}: restored to: ${expected}"
    else
        echo "   ${WEBHOOK_KEY}: differs from .env.example:"
        echo "     current:  ${current}"
        echo "     expected: ${expected}"
    fi

    for key in GATE_HOST_NAME GATE_HOST_IP GATE_CA_FILE NODE_EXTRA_CA_CERTS API_CA_CERT LLM_HOST_NAME LLM_HOST_IP LLM_CA_FILE; do
        if grep -qE "^${key}=" "$ENV_FILE"; then
            if [[ $APPLY -eq 1 ]]; then
                tmp="$(mktemp)"
                awk -v key="$key" '$0 !~ "^" key "=" { print }' "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
                echo "   ${key}: removed"
            else
                echo "   ${key}: present (would be removed) -> $(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
            fi
        fi
    done
else
    echo "   SKIPPED — ${ENV_FILE} or ${ENV_EXAMPLE} not found"
fi
echo

# ---------------------------------------------------------------------------
# 3c. The .env.local overrides
# ---------------------------------------------------------------------------
echo "3c. .env.local (the whole file is test-only)"

LOCAL_ENV="${LOCAL_ENV:-$REPO_ROOT/.env.local}"

if [[ -f "$LOCAL_ENV" ]]; then
    if [[ $APPLY -eq 1 ]]; then
        rm -f "$LOCAL_ENV"
        echo "   removed: ${LOCAL_ENV}"
    else
        echo "   present (would be removed): ${LOCAL_ENV}"
        echo "     it carries the webhook URL, the LLM env model and the sandbox provider"
    fi
else
    echo "   none"
fi
echo

# ---------------------------------------------------------------------------
# 3b. The private CA file mounted into the containers
# ---------------------------------------------------------------------------
echo "3b. The private CA files"

for ca in "${GATE_CA_FILE:-}" "${LLM_CA_FILE:-}"; do
    if [[ -n "$ca" && -f "$ca" ]]; then
        if [[ $APPLY -eq 1 ]]; then
            rm -f "$ca"
            echo "   removed: $ca"
        else
            echo "   present (would be removed): $ca"
        fi
    fi
done
[[ -z "${GATE_CA_FILE:-}" && -z "${LLM_CA_FILE:-}" ]] && echo "   none (set GATE_CA_FILE / LLM_CA_FILE to check)"
echo

# ---------------------------------------------------------------------------
# 4. Tracked files must not carry the local address
# ---------------------------------------------------------------------------
echo "4. Tracked files carrying the local test address"

scan_pattern=""
[[ -n "$TEST_GIT_HOST"    ]] && scan_pattern="${scan_pattern}${TEST_GIT_HOST}|"
[[ -n "$TEST_FORWARD_IP"  ]] && scan_pattern="${scan_pattern}${TEST_FORWARD_IP}|"
[[ -n "$TEST_WSL_IP"      ]] && scan_pattern="${scan_pattern}${TEST_WSL_IP}|"
scan_pattern="${scan_pattern%|}"

tracked_hits=""
if [[ -n "$scan_pattern" ]]; then
    tracked_hits="$(cd "$REPO_ROOT" && git grep -l -E "$scan_pattern" -- \
        ':!scripts/dev/cleanup-local-test-harness.sh' 2>/dev/null || true)"
else
    echo "   SKIPPED — set TEST_GIT_HOST / TEST_FORWARD_IP / TEST_WSL_IP to scan for them"
fi

if [[ -z "$tracked_hits" ]]; then
    echo "   clean — no tracked file carries the test address"
else
    echo "   FOUND (these would ship in the PR):"
    echo "$tracked_hits" | sed 's/^/     /'
    fail=1
fi
echo

# ---------------------------------------------------------------------------
# 5. Remote state (Gitea) — cannot be undone from here
# ---------------------------------------------------------------------------
echo "5. Git host instance (PAT + disposable repository)"
echo "   NOT automated — delete them on the git host:"
[[ -n "$TEST_TOKEN_URL" ]] && echo "     token:       ${TEST_TOKEN_URL}" || echo "     token:       (set TEST_TOKEN_URL)"
[[ -n "$TEST_REPO_URL"  ]] && echo "     repository:  ${TEST_REPO_URL}"  || echo "     repository:  (set TEST_REPO_URL)"
echo

# ---------------------------------------------------------------------------
echo "------------------------------------------------------------------"
if [[ $APPLY -eq 1 ]]; then
    if [[ $fail -eq 0 ]]; then
        echo "Local state cleaned. The Gitea token and repository still need removing."
    else
        echo "SOME CLEANUP FAILED — see the items marked FAILED above."
    fi
else
    echo "Report only. Re-run with --apply to undo the machine-local setup."
fi
exit $fail
