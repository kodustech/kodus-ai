#!/usr/bin/env bash
# Step 1 of 3 — boot the gitlab-ce container and wait for it to be
# healthy. Safe to re-run: `docker compose up -d` is a no-op when the
# container is already running, and the health poll exits on the first
# successful probe.
#
# After this returns you can browse http://gitlab.lvh.me:8929 in your
# browser (root / KodusDev!2026) before doing anything else.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

echo "════════════════════════════════════════════════════════════════"
echo " gitlab-dev — start"
echo "════════════════════════════════════════════════════════════════"

# The backend network is `external:` in the compose file. Surface a
# clearer hint than "network not found" if the dev stack hasn't been
# brought up yet.
if ! docker network inspect kodus-backend-services >/dev/null 2>&1; then
    cat >&2 <<EOF
error: docker network "kodus-backend-services" not found.

Start the dev backing services first:
    pnpm run docker:start
EOF
    exit 1
fi

echo
echo "==> docker compose up"
docker compose -f "${COMPOSE}" up -d

echo
echo "==> waiting for ${GITLAB_URL}/users/sign_in"
echo "    (first boot is 2-5 minutes — gitlab-ce reconfigures on cold start)"
# /users/sign_in returns 200 once the Rails app is serving requests
# and is stable across the gitlab-ce versions we support. The
# historically-recommended /-/health endpoint was removed/restricted
# in recent versions (returns 404), and /-/readiness requires a
# health-check token — sign-in is the simplest reliable probe.
DEADLINE=$(( $(date +%s) + 900 ))
last_status=""
while :; do
    status=$(curl -s -o /dev/null -w "%{http_code}" "${GITLAB_URL}/users/sign_in" || true)
    if [ "${status}" = "200" ]; then
        echo "    sign_in=${status}  OK"
        break
    fi
    if [ "${status}" != "${last_status}" ]; then
        echo "    sign_in=${status:-unreachable} (still booting…)"
        last_status="${status}"
    fi
    if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
        echo "error: gitlab did not become healthy within 15 minutes." >&2
        echo "       Tail logs: docker compose -f ${COMPOSE} logs -f gitlab" >&2
        exit 1
    fi
    sleep 5
done

cat <<EOF

  GitLab is up:  ${GITLAB_URL}
  Root login:    root / KodusDev!2026

  Next:
    bash scripts/gitlab-dev/create-project.sh   # seeds repo + mints PAT
    bash scripts/gitlab-dev/create-mr.sh        # opens the review MR
EOF
