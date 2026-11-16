#!/usr/bin/env bash
# The release tooling's half of S-17 (a) (docs/runtime/isolation-p3-snapshots.md,
# "S-17: the signed cell update"): makes the release key pair, or signs a
# release directory's SHA256SUMS into SHA256SUMS.sig after checking every file
# it lists.
#
# Usage:
#   scripts/sign-release.sh generate <private-key-out> <public-key-out>
#   RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE=<key> scripts/sign-release.sh sign <dir> <release>
#
# The private key never enters the tree: generate writes it 0600 where you
# say; the public line goes into internal/releasesig/keys/cell-release.pub.
set -euo pipefail

abs() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }

cmd=${1:-}
case "$cmd" in
    generate)
        private=$(abs "${2:?private key path}") public=$(abs "${3:?public key path}")
        cd "$(dirname "$0")/.."
        exec go run ./cmd/release-sign generate -private "$private" -public "$public"
        ;;
    sign)
        key=${RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE:?set RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE to the private key file}
        key=$(abs "$key") dir=$(abs "${2:?release directory}") release=${3:?release name}
        cd "$(dirname "$0")/.."
        exec go run ./cmd/release-sign sign -key "$key" -release "$release" -dir "$dir"
        ;;
    *)
        sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
