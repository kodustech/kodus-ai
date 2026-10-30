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

# Droplet name prefixes this script owns.
#
# `kodus-selfhosted-` is what provision.sh creates for manual/SSO droplets.
# `kodus-e2e-` is what the MATRIX creates — and it was missing here, so every
# matrix droplet was invisible to the reaper. Eight of them accumulated over
# 05-07/08/2026 until DigitalOcean started refusing to create new ones and the
# self-hosted matrix failed in provisioning ("Creating server..." then a jq
# parse error on a non-JSON error response).
#
# PREFIX stays defined as the primary one: it is used to rebuild a full name
# from a local state-file instance id, which only provision.sh writes.
PREFIX="kodus-selfhosted-"
PREFIXES=("kodus-selfhosted-" "kodus-e2e-")

# Fail-closed name guard. Anything not matching one of our prefixes is never
# deleted — prod (kodus-web-new) can never match.
matches_prefix() {
    local name="$1" p
    for p in "${PREFIXES[@]}"; do
        case "$name" in "$p"*) return 0 ;; esac
    done
    return 1
}

# Strip whichever prefix this droplet carries, for state-file lookups.
strip_prefix() {
    local name="$1" p
    for p in "${PREFIXES[@]}"; do
        case "$name" in "$p"*) printf '%s' "${name#$p}"; return 0 ;; esac
    done
    printf '%s' "$name"
}
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
# DigitalOcean is retired -- the matrix provisions on AWS. The token is no
# longer required: without one we skip DO entirely and still sweep EC2, which
# is the sweep that matters. Kept (rather than deleted) so leftover droplets
# can still be reaped by anyone who supplies a working token.

TTL_SECS=$(( TTL_HOURS * 3600 ))
NOW=$(date -u +%s)

# Parse an ISO-8601 UTC timestamp (e.g. 2026-06-29T12:34:56Z) to epoch seconds.
# Portable across GNU date (Linux/CI runners) and BSD date (macOS/dev Mac).
# Epoch seconds for an ISO-8601 timestamp, or EMPTY when it cannot be parsed.
#
# Empty, NOT 0. Returning 0 meant an unparseable timestamp read as "launched in
# 1970" — i.e. always older than any TTL — so the reaper would happily
# terminate a VM a run had just created. Callers must treat empty as "unknown
# age, leave it alone".
#
# AWS reports `2026-08-08T19:44:59+00:00`; DigitalOcean reports
# `2026-08-08T19:44:59Z`. GNU date (CI) takes both, BSD date (Mac) needs the
# exact format, so normalise the offset to Z before the BSD attempt.
iso_to_epoch() {
    local ts="${1:-}"
    [ -n "$ts" ] || return 0
    local norm="${ts/+00:00/Z}"
    norm="${norm%%.*}"
    case "$norm" in *Z) ;; *) norm="${norm}Z" ;; esac
    date -u -d "$ts" +%s 2>/dev/null \
        || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$norm" +%s 2>/dev/null \
        || true
}

is_kept() {
    local n="$1"
    for k in ${KEEP[@]+"${KEEP[@]}"}; do
        [ "$n" = "$k" ] && return 0
    done
    return 1
}

log "Reaping ${PREFIXES[*]} droplets on DigitalOcean"
if [ "$REAP_ALL" = "1" ]; then
    log "Mode: ALL (ignoring TTL)"
else
    log "Mode: older than ${TTL_HOURS}h"
fi
[ "$DRY_RUN" = "1" ] && warn "DRY RUN — nothing will be deleted"
[ "${#KEEP[@]}" -gt 0 ] && log "Exempt (--keep): ${KEEP[*]}"

# ---------- AWS EC2 sweep ----------
# Additive and independent of the DigitalOcean flow above, so it cannot break
# it. Runs only when a credential is present (locally that is usually absent,
# and in CI it is the region-boxed kodus-devops-agent user).
#
# Selection is by TAG, not by name. Name-prefix matching is exactly what let
# eight DigitalOcean droplets survive for days when the matrix started naming
# them `kodus-e2e-*` while the reaper watched `kodus-selfhosted-*`. A tag
# travels with the instance and cannot drift.
reap_aws_ec2() {
    # Loud, not dim. The matrix provisions on AWS by default, so a skipped EC2
    # sweep means instances bill forever -- and the job still exits 0, so the
    # only evidence anything was missed is this line. It ran silently in CI for
    # exactly that reason: reap-droplets.yml passed no AWS credential.
    command -v aws >/dev/null 2>&1 || { warn "aws CLI not found — EC2 sweep SKIPPED (leaked instances will not be reaped)"; return 0; }
    # Ask the CLI whether it can authenticate, rather than guessing from two
    # env vars. The env-var check passed in CI and silently skipped the sweep
    # everywhere else -- a default profile, SSO, an instance role and a
    # container role all authenticate fine and set neither variable, so the
    # one command that reaps leaked instances quietly did nothing while
    # printing a warning nobody was watching for.
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        warn "AWS credential does not authenticate — EC2 sweep SKIPPED (leaked instances will not be reaped)"
        return 0
    fi
    local region="${AWS_REGION_E2E:-${AWS_DEFAULT_REGION:-us-east-2}}"
    log "Reaping EC2 instances tagged Project=kodus-e2e in $region"

    local rows
    rows=$(aws ec2 describe-instances \
        --region "$region" \
        --filters "Name=tag:Project,Values=kodus-e2e" \
                  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
        --query 'Reservations[].Instances[].[InstanceId,LaunchTime,Tags[?Key==`Name`]|[0].Value]' \
        --output text 2>/dev/null) || { warn "Could not list EC2 instances in $region"; return 1; }

    # NOTE: do not return early when there are no instances — orphaned key
    # pairs are precisely the case where nothing is running, and an early
    # return skipped the cleanup below entirely.
    [ -n "$rows" ] || ok "No tagged EC2 instances in $region."

    local id launched name age age_h launched_epoch
    while read -r id launched name; do
        [ -n "$rows" ] || break
        [ -n "${id:-}" ] || continue
        launched_epoch=$(iso_to_epoch "$launched")
        if [ -z "$launched_epoch" ]; then
            warn "  skip   $id ${name:-} — could not parse LaunchTime '$launched'; refusing to guess its age"
            continue
        fi
        age=$(( NOW - launched_epoch ))
        age_h=$(( age / 3600 ))
        if [ "$REAP_ALL" != "1" ] && [ "$age" -lt "$TTL_SECS" ]; then
            dim "  young  $id ${name:-} (${age_h}h < ${TTL_HOURS}h) — keeping"
            continue
        fi
        if [ "$DRY_RUN" = "1" ]; then
            warn "  REAP   $id ${name:-} (${age_h}h old) [dry-run]"
            continue
        fi
        warn "  REAP   $id ${name:-} (${age_h}h old)"
        aws ec2 terminate-instances --region "$region" --instance-ids "$id" >/dev/null \
            && ok "Terminated $id" \
            || { warn "Could not terminate $id"; rc=1; }
    done <<< "$rows"

    # Key pairs outlive their instance when a run dies between import and
    # launch. They cost nothing but accumulate; drop the ones with no instance.
    #
    # "No instance" is NOT sufficient on its own, and assuming it was is what
    # broke a run with `InvalidKeyPair.NotFound`: a live run holds a key pair
    # and no instance for the whole window between import-key-pair and
    # run-instances. Sweeping on absence alone deletes the key out from under
    # it, and run-instances then fails on a key the run had just created.
    #
    # So key pairs get the same TTL guard the instances above get. A key
    # younger than the TTL may belong to a run still in flight; only an old
    # one is provably an orphan.
    local kp created kp_epoch kp_age kp_age_h
    while read -r kp created; do
        [ -n "${kp:-}" ] || continue
        case "$kp" in
            kodus-e2e-*)
                if echo "$rows" | grep -q "$kp"; then continue; fi
                kp_epoch=$(iso_to_epoch "$created")
                if [ -z "$kp_epoch" ]; then
                    warn "  skip   key pair $kp — could not parse CreateTime '$created'; refusing to guess its age"
                    continue
                fi
                kp_age=$(( NOW - kp_epoch ))
                kp_age_h=$(( kp_age / 3600 ))
                if [ "$REAP_ALL" != "1" ] && [ "$kp_age" -lt "$TTL_SECS" ]; then
                    dim "  young  key pair $kp (${kp_age_h}h < ${TTL_HOURS}h) — a run may still be launching with it"
                    continue
                fi
                [ "$DRY_RUN" = "1" ] \
                    && dim "  would drop stale key pair $kp (${kp_age_h}h old)" \
                    || { aws ec2 delete-key-pair --region "$region" --key-name "$kp" >/dev/null 2>&1 \
                         && dim "  dropped stale key pair $kp (${kp_age_h}h old)"; }
                ;;
        esac
    done < <(aws ec2 describe-key-pairs --region "$region" --query 'KeyPairs[].[KeyName,CreateTime]' --output text 2>/dev/null)
}

# ---------- pull live droplets (source of truth) ----------
# A dead DigitalOcean token must not take the EC2 sweep down with it. The two
# clouds are independent, the matrix provisions on AWS now, and `exit 1` here
# meant an expired DO credential silently stopped the only cleanup that still
# matters -- leaked instances billing while the job merely reported failure
# (observed: run 31629073157, DO returning 401).
if [ -z "${DIGITALOCEAN_TOKEN:-}" ]; then
    log "No DIGITALOCEAN_TOKEN - DigitalOcean is retired; sweeping EC2 only."
    rc=0
    reap_aws_ec2 || rc=1
    [ "$rc" -eq 0 ] && ok "Reap complete (EC2 only)." || warn "Reap completed with failures (rc=$rc)."
    exit "$rc"
fi

if ! DROPLETS_JSON=$(curl -fsS \
    -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
    "https://api.digitalocean.com/v2/droplets?per_page=200"); then
    # A token that is SET but rejected is different from no token: someone
    # meant DigitalOcean to be reaped and it was not. Sweep EC2 anyway, then
    # fail so the dead credential stays visible.
    err "DigitalOcean returned an error (token expired or revoked?) - skipping DO, still sweeping EC2"
    rc=0
    reap_aws_ec2 || rc=1
    err "DigitalOcean reap did NOT run. Rotate DIGITALOCEAN_TOKEN, or unset it if DO is gone for good."
    exit 1
fi

# name<TAB>id<TAB>created_at, filtered to our prefix.
PREFIX_JSON=$(printf '%s\n' "${PREFIXES[@]}" | jq -R . | jq -sc .)
MATCHES=$(echo "$DROPLETS_JSON" | jq -r \
    --argjson ps "$PREFIX_JSON" \
    '.droplets[] | select([.name | startswith($ps[])] | any) | "\(.name)\t\(.id)\t\(.created_at)"')

LIVE_NAMES=$(echo "$DROPLETS_JSON" | jq -r '.droplets[].name')

# ---------- decide what to reap ----------
TO_REAP=()        # instance short-names (suffix after prefix)
TO_REAP_IDS=()    # parallel array of droplet ids
TO_REAP_NAMES=()  # parallel array of FULL droplet names (namespace intact)
SKIPPED_YOUNG=0

if [ -n "$MATCHES" ]; then
    while IFS=$'\t' read -r name id created; do
        [ -n "$name" ] || continue
        short="$(strip_prefix "$name")"
        if is_kept "$short"; then
            dim "  keep   $name (exempt)"
            continue
        fi
        created_epoch=$(iso_to_epoch "$created")
        if [ -z "$created_epoch" ]; then
            warn "  skip   $name — could not parse created_at '$created'; refusing to guess its age"
            continue
        fi
        age=$(( NOW - created_epoch ))
        age_h=$(( age / 3600 ))
        if [ "$REAP_ALL" != "1" ] && [ "$age" -lt "$TTL_SECS" ]; then
            dim "  young  $name (${age_h}h < ${TTL_HOURS}h) — keeping"
            SKIPPED_YOUNG=$(( SKIPPED_YOUNG + 1 ))
            continue
        fi
        warn "  REAP   $name (${age_h}h old, id=$id)"
        TO_REAP+=("$short")
        TO_REAP_IDS+=("$id")
        TO_REAP_NAMES+=("$name")
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


rc=0

if [ "${#TO_REAP[@]}" -eq 0 ] && [ "${#ORPHAN_STATES[@]}" -eq 0 ]; then
    ok "Nothing to reap on DigitalOcean. (${SKIPPED_YOUNG} droplet(s) still within TTL.)"
    # Still sweep EC2 — once the matrix runs on AWS this is the only sweep
    # that matters, and gating it behind DigitalOcean having work to do would
    # silently disable it.
    reap_aws_ec2 || rc=1

[ "$rc" -eq 0 ] && ok "Reap complete." || warn "Reap completed with some failures (rc=$rc)."
    exit "$rc"
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
    full_name="${TO_REAP_NAMES[$(( i - 1 ))]}"
    # destroy.sh addresses instances by SHORT name, which is ambiguous across
    # namespaces: kodus-e2e-github and kodus-selfhosted-github both strip to
    # "github". Delegating an e2e droplet to destroy.sh would hand it a name
    # that resolves to the SELFHOSTED droplet's state file and destroy that
    # machine instead -- a different, live host, irreversibly.
    #
    # destroy.sh owns the kodus-selfhosted-* namespace only. Everything else
    # goes down the API path below, which deletes by droplet ID and re-verifies
    # the live name first.
    if [ "${full_name#kodus-selfhosted-}" != "$full_name" ] && state_exists "$short"; then
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
        if matches_prefix "$live_name"; then
                log "orphan delete id=$id ($live_name)"
                curl -fsS -X DELETE \
                    -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                    "https://api.digitalocean.com/v2/droplets/$id" >/dev/null \
                    && ok "Destroyed orphan droplet $id ($live_name)" \
                    || { warn "Could not destroy orphan $id"; rc=1; }
        else
                err "SAFETY: orphan id=$id live name '$live_name' matches none of ${PREFIXES[*]} — skipping."
                rc=1
        fi
    fi
done

# ---------- clean stale state files ----------
for inst in ${ORPHAN_STATES[@]+"${ORPHAN_STATES[@]}"}; do
    sf="$(state_file_for "$inst")"
    key="$(ssh_key_path_for "$inst")"
    rm -f "$sf" "$key" "$key.pub" 2>/dev/null || true
    ok "Cleaned stale state for '$inst'"
done

reap_aws_ec2 || rc=1

[ "$rc" -eq 0 ] && ok "Reap complete." || warn "Reap completed with some failures (rc=$rc)."
exit $rc
