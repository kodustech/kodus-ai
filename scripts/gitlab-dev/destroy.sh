#!/usr/bin/env bash
# Tear down the GitLab dev fixture and remove its volumes + bootstrap
# artefacts. The dev backing services (postgres/mongo/rabbit) and the
# `kodus-backend-services` network are left untouched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${REPO_ROOT}/docker/gitlab-dev/docker-compose.yml"

echo "==> stopping gitlab-dev and removing volumes"
docker compose -f "${COMPOSE}" down -v

for f in \
    "${REPO_ROOT}/.tmp/gitlab-dev-admin-pat.txt" \
    "${REPO_ROOT}/.tmp/gitlab-dev-pat.txt" \
    "${REPO_ROOT}/.tmp/gitlab-dev-project-url.txt" \
    "${REPO_ROOT}/.tmp/gitlab-dev-project-id.txt" \
    "${REPO_ROOT}/.tmp/gitlab-dev-mr-url.txt"
do
    [ -f "${f}" ] && rm -f "${f}"
done

echo "done."
