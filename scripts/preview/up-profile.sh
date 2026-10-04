#!/usr/bin/env bash
# Brings ONE shape of the pull request's preview up (or reconciles it) and
# prints its public URL. The preview workflow calls this once per wanted
# profile; a profile the PR no longer wants is torn down with
#   $RUNO destroy --branch "$HEAD_REF" --profile <name>
#
#   usage: up-profile.sh <cloud|self-hosted> <branch>
#   env:   RUNO (the runo command), RUNO_SERVER, RUNO_TOKEN
#   out:   the URL on stdout (last line); everything else on stderr
set -euo pipefail

PROFILE="${1:?usage: up-profile.sh <cloud|self-hosted> <branch>}"
HEAD_REF="${2:?usage: up-profile.sh <cloud|self-hosted> <branch>}"
: "${RUNO:?RUNO is not set (e.g. 'bun /path/to/runo/bin/runo.ts')}"

case "$PROFILE" in
    cloud)
        RECIPE=.kodus/workspace.preview.yaml
        OVERLAY=docker-compose.preview.cloud.yml
        # billing runs from its own repository; MCP's health is the other optional probe
        READY="curl -fsS http://127.0.0.1:3101/health >/dev/null && curl -fsS http://127.0.0.1:3992/health/ready >/dev/null"
        ;;
    self-hosted)
        RECIPE=.kodus/workspace.preview.selfhosted.yaml
        OVERLAY=docker-compose.preview.selfhosted.yml
        READY="curl -fsS http://127.0.0.1:3101/health >/dev/null"
        ;;
    *) echo "unknown profile: $PROFILE (cloud | self-hosted)" >&2; exit 2 ;;
esac

# runo's own flags go BEFORE `--`; everything after it is the remote command
runo() {
    local own=()
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do own+=("$1"); shift; done
    $RUNO "${own[@]}" --branch "$HEAD_REF" --profile "$PROFILE" "$@"
}
compose="docker compose -f docker-compose.dev.yml -f docker-compose.preview.yml -f $OVERLAY --profile mcp"

{
    echo "::group::preview [$PROFILE] up"
    # --branch: the checkout is a detached HEAD, so runo cannot read the
    # branch from git itself. --profile makes this env distinct from the
    # other shape of the same branch (see runo's README, "Profiles").
    # A VM holding an unparseable compose file wedges: `up` validates the
    # compose files that are ON the machine, and only a later `push` syncs
    # this commit onto it, so every deploy dies in that validation and the
    # commit that repairs the file never lands. `push` alone cannot break the
    # cycle either — it resolves the env through runo's registry, which lives
    # in RUNO_HOME and is empty on a fresh runner. Only `up` adopts a running
    # instance by its AWS tags, and it registers the adoption BEFORE
    # reconciling, so even a failed `up` leaves an entry `push` can resolve.
    # Both repairs are best-effort: a first deploy has nothing to adopt.
    runo up --here --recipe "$RECIPE" || true
    runo push --recipe "$RECIPE" || true

    runo up --here --recipe "$RECIPE"
    if [ "$PROFILE" = cloud ]; then
        # The billing context tracks its own repository. Rebuild its pinned
        # local image before restarting, otherwise compose can keep serving
        # the image baked by the previous PR push.
        runo exec -- "$compose build kodus-service-billing" ||
            echo "::warning::[$PROFILE] kodus-service-billing image rebuild failed — keeping the previous image"
    fi
    # `up` only uploads code when it CREATES the VM; on every later push the
    # environment already exists and the new commit travels with push
    # (compose watch reloads it)
    runo push --restart --recipe "$RECIPE"
    # Runo's data step retries automatically. Keep optional service readiness
    # outside it so one failed MCP/billing probe does not hide the real
    # container logs for 15min. A cold MCP manager runs its seeds under
    # ts-node before it listens, which takes longer than the old 5min.
    runo exec -- "timeout 900 bash -c 'until $READY; do sleep 5; done'"
    # The recipe seeds as part of `up`'s data step, which runs BEFORE `push`
    # syncs this commit — and on an environment that already exists `up`
    # skips setup entirely, so the seed never sees the code being previewed.
    # Re-run it once here, after the sync and the health wait, so a change to
    # the seed takes effect on the deploy that introduces it. Non-fatal: a
    # preview that fails to re-seed still deploys with the previous data.
    runo exec -- pnpm run seed:preview ||
        echo "::warning::[$PROFILE] post-sync seed:preview failed — the preview may be carrying the previous commit's seed"
    echo "::endgroup::"
} >&2

URL=$(runo url --recipe "$RECIPE" | head -1)
# Sharing is useful to QA but must not prevent a valid application deploy
# from publishing its URL.
runo share qa >&2 || echo "::warning::[$PROFILE] preview deployed, but QA sharing failed" >&2
echo "$URL"
