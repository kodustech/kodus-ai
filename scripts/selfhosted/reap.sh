#!/usr/bin/env bash
# Reap stale self-hosted test droplets — reconciles against the provider API
# (the source of truth), NOT local state files. This catches the leak that
# destroy.sh/bench-down.sh can't: a droplet whose state file was lost (worktree
# cleanup, run from another dir, crash before the state was written) is invisible
# to the state-file-driven cleanup and bills forever.
#
# What it does:
#   1. Lists LIVE droplets from DigitalOcean.
#   2. Filters to the `kodus-selfhosted-*` test prefix (prod like kodus-web-new
#      never matches, so it's never touched).
#   3. Destroys any matching droplet older than TTL_HOURS (default 6).
#      - If a state file exists -> delegates to destroy.sh (full cleanup:
#        droplet + SSH key + state, with its own prefix safety guard).
#      - If no state file (true orphan) -> deletes via the API directly,
#        after re-confirming the live name matches the prefix (fail-closed).
#   4. Sweeps orphaned state files whose droplet no longer exists at the provider.
#
# Usage:
#   pnpm run selfhosted:reap                 # reap kodus-selfhosted-* older than 6h (prompts once)
#   pnpm run selfhosted:reap -y              # no prompt (for cron)
#   pnpm run selfhosted:reap --ttl 3         # custom TTL in hours
#   pnpm run selfhosted:reap --all           # ignore TTL: reap ALL kodus-selfhosted-*
#   pnpm run selfhosted:reap --dry-run       # show what would be reaped, change nothing
#   pnpm run selfhosted:reap --keep default  # exempt one instance (repeatable)
#
# Only DigitalOcean is supported here (the bench farm + matrix run on DO).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

PREFIX="kodus-selfhosted-"
TTL_HOURS=6
ASSUME_YES=0
DRY_RUN=0
REAP_ALL=0
KEEP=()

while [ $# -gt 0 ]; do
    case "$1" in
        --ttl) TTL_HOURS="$2"; shift 2 ;;
        --ttl=*) TTL_HOURS="${1#--ttl=}"; shift ;;
        --all) REAP_ALL=1; shift ;;
        --dry-run|-n) DRY_RUN=1; shift ;;
        --keep) KEEP+=("$(normalize_name "$2")"); shift 2 ;;
        --keep=*) KEEP+=("$(normalize_name "${1#--keep=}")"); shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \?//'; exit 0 ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done

require_cmd jq
require_cmd curl
require_env DIGITALOCEAN_TOKEN

TTL_SECS=$(( TTL_HOURS * 3600 ))
NOW=$(date -u +%s)

# Parse an ISO-8601 UTC timestamp (e.g. 2026-06-29T12:34:56Z) to epoch seconds.
# Portable across GNU date (Linux/CI runners) and BSD date (macOS/dev Mac).
iso_to_epoch() {
    # GNU date first (CI), then BSD date (Mac); 0 if neither parses.
    date -u -d "$1" +%s 2>/dev/null \
        || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null \
        || echo 0
}

is_kept() {
    local n="$1"
    for k in ${KEEP[@]+"${KEEP[@]}"}; do
        [ "$n" = "$k" ] && return 0
    done
    return 1
}

log "Reaping ${PREFIX}* droplets on DigitalOcean"
if [ "$REAP_ALL" = "1" ]; then
    log "Mode: ALL (ignoring TTL)"
else
    log "Mode: older than ${TTL_HOURS}h"
fi
[ "$DRY_RUN" = "1" ] && warn "DRY RUN — nothing will be deleted"
[ "${#KEEP[@]}" -gt 0 ] && log "Exempt (--keep): ${KEEP[*]}"

# ---------- pull live droplets (source of truth) ----------
DROPLETS_JSON=$(curl -fsS \
    -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
    "https://api.digitalocean.com/v2/droplets?per_page=200") \
    || { err "Failed to list droplets from DigitalOcean"; exit 1; }

# name<TAB>id<TAB>created_at, filtered to our prefix.
MATCHES=$(echo "$DROPLETS_JSON" | jq -r \
    --arg p "$PREFIX" \
    '.droplets[] | select(.name | startswith($p)) | "\(.name)\t\(.id)\t\(.created_at)"')

LIVE_NAMES=$(echo "$DROPLETS_JSON" | jq -r '.droplets[].name')

# ---------- decide what to reap ----------
TO_REAP=()        # instance short-names (suffix after prefix)
TO_REAP_IDS=()    # parallel array of droplet ids
SKIPPED_YOUNG=0

if [ -n "$MATCHES" ]; then
    while IFS=$'\t' read -r name id created; do
        [ -n "$name" ] || continue
        short="${name#$PREFIX}"
        if is_kept "$short"; then
            dim "  keep   $name (exempt)"
            continue
        fi
        age=$(( NOW - $(iso_to_epoch "$created") ))
        age_h=$(( age / 3600 ))
        if [ "$REAP_ALL" != "1" ] && [ "$age" -lt "$TTL_SECS" ]; then
            dim "  young  $name (${age_h}h < ${TTL_HOURS}h) — keeping"
            SKIPPED_YOUNG=$(( SKIPPED_YOUNG + 1 ))
            continue
        fi
        warn "  REAP   $name (${age_h}h old, id=$id)"
        TO_REAP+=("$short")
        TO_REAP_IDS+=("$id")
    done <<< "$MATCHES"
fi

# ---------- find orphaned state files (droplet already gone) ----------
ORPHAN_STATES=()
while IFS= read -r inst; do
    [ -n "$inst" ] || continue
    full="${PREFIX}${inst}"
    if ! echo "$LIVE_NAMES" | grep -qx "$full"; then
        ORPHAN_STATES+=("$inst")
        dim "  stale  state file for '$inst' (no live droplet) — will clean"
    fi
done < <(list_instances)

if [ "${#TO_REAP[@]}" -eq 0 ] && [ "${#ORPHAN_STATES[@]}" -eq 0 ]; then
    ok "Nothing to reap. (${SKIPPED_YOUNG} droplet(s) still within TTL.)"
    exit 0
fi

echo
log "Plan: reap ${#TO_REAP[@]} droplet(s), clean ${#ORPHAN_STATES[@]} stale state file(s)."
if [ "$DRY_RUN" = "1" ]; then
    ok "Dry run complete — no changes made."
    exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "$(echo -e "${YELLOW}Continue? (y/N): ${NC}")" REPLY
    [[ "$REPLY" =~ ^[Yy]$ ]] || { dim "Aborted."; exit 0; }
fi

rc=0

# ---------- reap live droplets ----------
i=0
for short in ${TO_REAP[@]+"${TO_REAP[@]}"}; do
    id="${TO_REAP_IDS[$i]}"
    i=$(( i + 1 ))
    if state_exists "$short"; then
        # Full cleanup path (droplet + SSH key + state) with destroy.sh's own
        # live-name prefix safety guard.
        log "destroy.sh --name $short (has state file)"
        bash "$SCRIPT_DIR/destroy.sh" --name "$short" -y || { warn "destroy.sh failed for $short"; rc=1; }
    else
        # True orphan: no state file, so destroy.sh can't see it. Delete via API
        # directly, but re-confirm the live name still matches the prefix first
        # (fail-closed — never delete an unverified droplet).
        live_name=$(curl -fsS \
            -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
            "https://api.digitalocean.com/v2/droplets/$id" 2>/dev/null \
            | jq -r '.droplet.name // ""' 2>/dev/null || echo "")
        case "$live_name" in
            "${PREFIX}"*)
                log "orphan delete id=$id ($live_name)"
                curl -fsS -X DELETE \
                    -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                    "https://api.digitalocean.com/v2/droplets/$id" >/dev/null \
                    && ok "Destroyed orphan droplet $id ($live_name)" \
                    || { warn "Could not destroy orphan $id"; rc=1; }
                ;;
            *)
                err "SAFETY: orphan id=$id live name '$live_name' is not ${PREFIX}* — skipping."
                rc=1
                ;;
        esac
    fi
done

# ---------- clean stale state files ----------
for inst in ${ORPHAN_STATES[@]+"${ORPHAN_STATES[@]}"}; do
    sf="$(state_file_for "$inst")"
    key="$(ssh_key_path_for "$inst")"
    rm -f "$sf" "$key" "$key.pub" 2>/dev/null || true
    ok "Cleaned stale state for '$inst'"
done

[ "$rc" -eq 0 ] && ok "Reap complete." || warn "Reap completed with some failures (rc=$rc)."
exit $rc
