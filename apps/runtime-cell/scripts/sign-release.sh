#!/usr/bin/env bash
# The release tooling's half of S-17 (a) (docs/runtime/isolation-p3-snapshots.md,
# "S-17: the signed cell update"): makes the release key pair, or signs a
# release directory's SHA256SUMS into SHA256SUMS.sig after checking every file
# it lists.
#
# Usage:
#   scripts/sign-release.sh generate <private-key-out> <public-key-out>
#   RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE=<key> scripts/sign-release.sh sign <dir> <release>
#   RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE=<key> scripts/sign-release.sh index <dir> <latest> <minimum> [valid-days] [revoked-key-ids]
#   RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE=<key> scripts/sign-release.sh bundle <release-dir> <release> <images.tsv> <runsc ARCH=FILE,...> <out>
#
# bundle writes the offline bundle of a signed release (internal/releasesig/bundle.go)
# for an air-gapped host: the release, every image as an OCI archive and the
# runsc archives, listed with their sha256 in BUNDLE, signed with the same key.
# images.tsv is "<component>\t<repository@sha256:...>\t<archive>" per line;
# each archive is saved beforehand, by digest, with every platform:
#   skopeo copy --all docker://<repository@sha256:...> oci-archive:<archive>
# The tool refuses an archive whose index.json does not list its pinned digest.
#
# index writes the signed release index (RELEASE-INDEX, internal/releasesig/index.go)
# a cell requires before it installs: re-issue it before it expires.
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
    index)
        key=${RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE:?set RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE to the private key file}
        key=$(abs "$key") dir=$(abs "${2:?index directory}") latest=${3:?latest release} minimum=${4:?minimum release}
        days=${5:-90} revoke=${6:-}
        cd "$(dirname "$0")/.."
        exec go run ./cmd/release-sign index -key "$key" -latest "$latest" -minimum "$minimum" -valid-days "$days" -revoke "$revoke" -dir "$dir"
        ;;
    bundle)
        key=${RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE:?set RUNTIME_CELL_RELEASE_SIGNING_KEY_FILE to the private key file}
        key=$(abs "$key") dir=$(abs "${2:?release directory}") release=${3:?release name}
        images=$(abs "${4:?images.tsv}") runsc=${5:-} out=$(abs "${6:?bundle directory}")
        cd "$(dirname "$0")/.."
        exec go run ./cmd/release-sign bundle -key "$key" -release "$release" -release-dir "$dir" -images "$images" -runsc "$runsc" -out "$out"
        ;;
    *)
        sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
