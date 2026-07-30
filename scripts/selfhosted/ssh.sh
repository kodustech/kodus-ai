#!/usr/bin/env bash
# Opens an SSH session into the named self-hosted instance, or runs a remote
# command if extra args are given.
#
# Usage:
#   pnpm run selfhosted:ssh
#   pnpm run selfhosted:ssh --name wellington
#   pnpm run selfhosted:ssh -- 'docker compose ps'   # one-shot command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

NAME_RAW="default"
REMOTE_CMD=""
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        --) shift; REMOTE_CMD="$*"; break ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            # Yarn 1 eats the first `--`, so `pnpm run selfhosted:ssh -- 'cmd'`
            # arrives here as `'cmd'`. Accept it as the remote command —
            # this arg and any others are the command to run on the droplet.
            REMOTE_CMD="$*"; break
            ;;
    esac
done
NAME=$(normalize_name "$NAME_RAW")
state_exists "$NAME" || { err "No instance named '$NAME'. Run 'pnpm run selfhosted:provision' first."; exit 1; }

IP=$(state_get "$NAME" .server_ip)
KEY=$(state_get "$NAME" .ssh_key_path)
[ -f "$KEY" ] || { err "SSH key file missing: $KEY"; exit 1; }

if [ -n "$REMOTE_CMD" ]; then
    exec ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=10 "root@$IP" "$REMOTE_CMD"
else
    exec ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=10 "root@$IP"
fi
