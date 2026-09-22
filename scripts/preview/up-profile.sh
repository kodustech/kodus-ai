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

runo() { $RUNO "$@" --branch "$HEAD_REF" --profile "$PROFILE"; }
compose="docker compose -f docker-compose.dev.yml -f docker-compose.preview.yml -f $OVERLAY --profile mcp"

{
    echo "::group::preview [$PROFILE] up"
    # --branch: the checkout is a detached HEAD, so runo cannot read the
    # branch from git itself. --profile makes this env distinct from the
    # other shape of the same branch (see runo's README, "Profiles").
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
    # container logs for 15min.
    runo exec -- "timeout 300 bash -c 'until $READY; do sleep 3; done'"
    echo "::endgroup::"
} >&2

URL=$(runo url --recipe "$RECIPE" | head -1)
# Sharing is useful to QA but must not prevent a valid application deploy
# from publishing its URL.
runo share qa >&2 || echo "::warning::[$PROFILE] preview deployed, but QA sharing failed" >&2
echo "$URL"
